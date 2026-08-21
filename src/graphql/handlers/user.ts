import { userDb as _userDb } from '../../db/dbInit'
import { StatusEnum } from '../../../types'
import {
  signSessionToken,
  LOGIN_SESSION_TTL_SECONDS,
} from '../../utils/sessionTtl'
import { hashPassword } from '../../utils/password'
import type { ClearUserSchema, UserSchema } from '../../../types'
import { getFullLocationByIp } from './ip'
import { JWT_SECRET } from '../../config'
import DB from '../../db'

if (!JWT_SECRET) {
  throw Error('missing jwt secret')
}

export const createOrUpdateUser = async (
  user: {
    email: string
    password: string
    picture?: string
    lastName?: string
    timezone?: string
    name?: string
    weekStart?: string
    licenseKey?: string
  },
  userAgent?: string,
  ip?: string,
  create = false,
) => {
  const { picture, lastName, name, password, weekStart } = user
  let { email, timezone } = user
  if (timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone })
    } catch (e) {
      timezone = 'UTC'
    }
  }
  email = email.toLowerCase()
  const findUser = await _userDb.readData({
    username: email,
  })
  if (findUser.status === StatusEnum.notok) {
    return findUser
  }
  // SECURITY (GHSA-7gxr-ppgj-jjg8): this used to hand `jwt.sign` an ms-epoch
  // timestamp as `expiresIn`, which jsonwebtoken reads as SECONDS — signing an
  // `exp` ~56,000 years out, so no session ever expired. `signSessionToken`
  // takes seconds and reports the window the token actually carries, so the
  // persisted `expiredAt` and the enforced `exp` claim cannot drift apart.
  const {
    token: jwtToken,
    createdAt: sessionCreatedAt,
    expiredAt: sessionExpiredAt,
  } = signSessionToken(
    {
      username: email,
      authorized: true,
    },
    JWT_SECRET,
    LOGIN_SESSION_TTL_SECONDS,
  )
  const expire = sessionExpiredAt.getTime()
  if (findUser.data.result) {
    const set: { [x: string]: unknown } = {
      $push: {
        tokens: [
          {
            token: jwtToken,
            createdAt: +sessionCreatedAt,
            expiredAt: expire,
            ip,
            userAgent,
          },
        ],
      },
    }
    if (ip) {
      let ips = findUser.data.result.ips ?? []
      const find = ips.find((d) => d.ip === ip)
      if (find) {
        find.updated = new Date()
        ips = [...ips.filter((d) => d.ip !== find.ip), find]
        set.ips = ips
      } else {
        const location = await getFullLocationByIp(ip)
        ips.push({
          ip,
          userAgent,
          location: location
            ? { country: location.Country, city: location.City }
            : undefined,
        })
        if (ips.length > 10) {
          ips.shift()
        }
        set.ips = ips
      }
    }
    set.last_active = +new Date()
    const saveDataRequest = await _userDb.updateData(
      { username: email },
      {
        ...set,
      },
      true,
    )
    if (saveDataRequest.status === StatusEnum.notok) {
      return saveDataRequest
    }
    return {
      status: StatusEnum.ok,
      reason: 'User logged in',
      data: {
        token: jwtToken,
        shouldOnBoard: saveDataRequest.data.shouldOnBoard,
        shouldOnBoardExchange: saveDataRequest.data.shouldOnBoardExchange,
      },
    }
  } else if (timezone && create) {
    const location = await getFullLocationByIp(ip)
    const userToAdd: Omit<ClearUserSchema, '_id'> = {
      username: email,
      password: await hashPassword(password),
      tokens: [
        {
          token: jwtToken,
          createdAt: +new Date(),
          expiredAt: expire,
          ip,
          userAgent,
        },
      ],
      exchanges: [],
      timezone,
      picture,
      name,
      lastName,
      shouldOnBoard: true,
      shouldOnBoardExchange: true,
      onboardingSteps: {
        signup: true,
        liveExchange: false,
        deployLiveBot: false,
        earnProfit: false,
      },
      displayName: name ?? null,
      ips: [
        {
          ip,
          userAgent,
          location: location
            ? { country: location?.Country, city: location?.City }
            : undefined,
        },
      ],
      weekStart: weekStart || 'm',
      licenseKey: user.licenseKey,
    }
    const createDataRequest = await _userDb.createData(userToAdd)
    if (createDataRequest.status === StatusEnum.notok) {
      return createDataRequest
    }
    return {
      status: StatusEnum.ok,
      reason: 'User signed in',
      data: {
        token: jwtToken,
        shouldOnBoard: true,
        shouldOnBoardExchange: true,
      },
    }
  }
}

export const findUser = async <T extends UserSchema>(
  token: string,
  userDb: DB<T> = _userDb as unknown as DB<T>,
) => {
  if (token !== '') {
    const userFind =
      token === 'demo'
        ? await userDb.readData({
            demo: true,
          })
        : await userDb.readData({
            tokens: { $elemMatch: { token } },
          })
    if (userFind.status === StatusEnum.ok) {
      if (userFind.data && userFind.data.result) {
        return {
          status: StatusEnum.ok as typeof StatusEnum.ok,
          reason: null,
          data: userFind.data.result,
        }
      }
    }
    if (userFind.status === StatusEnum.notok) {
      return userFind
    }
  }
  return {
    status: StatusEnum.notok as typeof StatusEnum.notok,
    reason: 'User not found',
    data: null,
  }
}
