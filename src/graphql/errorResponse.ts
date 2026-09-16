import { StatusEnum } from '../../types'

export const findUserNotOk = () => ({
  status: StatusEnum.notok,
  reason: `Something went wrong while trying to find the user`,
  data: null,
})
export const userNotFoundById = () => ({
  status: StatusEnum.notok,
  reason: `No user with such id found`,
  data: null,
})

export const updateUserError = () => ({
  status: StatusEnum.notok,
  reason: `Something went wrong while trying to update the user`,
  data: null,
})

export const findUserActiveBotsNotOk = () => ({
  status: StatusEnum.notok,
  reason: `Something went wrong while trying to find users' active bots`,
  data: null,
})
export const findUserActiveComboBotsNotOk = () => ({
  status: StatusEnum.notok,
  reason: `Something went wrong while trying to find users' active bots`,
  data: null,
})
export const findUserActiveBotsNotFoundByUserId = () => ({
  status: StatusEnum.notok,
  reason: `No users' active bots found`,
  data: null,
})
export const findUserActiveComboBotsNotFoundByUserId = () => ({
  status: StatusEnum.notok,
  reason: `No users' active bots found`,
  data: null,
})

export const insufficientFunds = () => ({
  status: StatusEnum.notok,
  reason: `Insufficient funds`,
  data: null,
})

/**
 * No backtest behind the requested id. One refusal covers every way that
 * happens — never saved to the server, deleted, cleaned up by the 30-day
 * sweep of non-permanent runs, owned by somebody else, or not an id at all —
 * because the caller cannot act differently on any of them, and telling them
 * apart would report whether an id they do not own exists.
 */
export const backtestNotFound = () => ({
  status: StatusEnum.notok,
  reason: 'Backtest not found',
  data: null,
})

export const errorAccess = () => ({
  status: StatusEnum.notok,
  reason: 'Cannot access',
})
