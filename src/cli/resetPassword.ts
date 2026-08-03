import { userDb } from '../db/dbInit'
import { hashPassword } from '../utils/password'
import { verifyPassword } from '../graphql/handlers/password'
import { StatusEnum } from '../../types'
import logger from '../utils/logger'

/**
 * CLI utility to reset user password
 * Usage: npm run cli:reset-password -- <username> <newPassword>
 */
async function resetPassword() {
  const args = process.argv.slice(2)

  if (args.length < 2) {
    logger.error(
      'Usage: npm run cli:reset-password -- <username> <newPassword>',
    )
    logger.error('Example: npm run cli:reset-password -- admin MyNewPass123')
    process.exit(1)
  }

  const [username, newPassword] = args
  const email = username.toLowerCase()

  try {
    // Verify password format
    if (!verifyPassword(newPassword)) {
      logger.error(
        'Password must be at least 6 characters with uppercase, lowercase, and number',
      )
      process.exit(1)
    }

    // Find the user
    const findUser = await userDb.readData({ username: email })

    if (findUser.status === StatusEnum.notok || !findUser.data.result) {
      logger.error(`User "${email}" not found`)
      process.exit(1)
    }

    // Update password. Stored as a bcrypt hash, matching every other write
    // path — this must never put a reversible credential back in the database.
    const hashedPassword = await hashPassword(newPassword)
    const updateResult = await userDb.updateData(
      { _id: findUser.data.result._id.toString() },
      { $set: { password: hashedPassword } },
    )

    if (updateResult.status === StatusEnum.notok) {
      logger.error('Failed to update password:', updateResult.reason)
      process.exit(1)
    }

    logger.info(`✓ Password reset successfully for user "${email}"`)
    process.exit(0)
  } catch (error) {
    logger.error('Error resetting password:', error)
    process.exit(1)
  }
}

resetPassword()
