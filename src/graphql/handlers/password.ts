// The canonical password policy for the platform.
//
// Every path that SETS a password runs this: cloud change-password, cloud
// password reset, self-hosted change-password and the self-hosted CLI reset.
// It deliberately does NOT run on login — an existing password keeps working
// whatever this rule says, so tightening it never locks anyone out.
//
// There used to be three different rules. This one required 6 characters with
// an uppercase, a lowercase and a digit; the cloud reset endpoint separately
// required 8 characters and no character classes at all; self-hosted
// registration checked nothing. A password could therefore be accepted by one
// path and refused by another, and the UI could only ever match one of them.
//
// Expressed as lookaheads plus an explicit length test rather than one
// anchored pattern, so it matches the dashboard's checklist exactly: the old
// `.{6,}$` form also rejected any password containing a newline, which the
// checklist allowed. The character classes stay ASCII, which the checklist
// mirrors — an accented capital is not counted as an uppercase letter by
// either side.
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 200

// Single user-facing wording, so a rejection reads the same wherever it comes
// from. Keep it in step with the dashboard's checklist labels.
export const PASSWORD_REQUIREMENTS_MESSAGE =
  'Password must be 8-200 characters and include an uppercase letter, a lowercase letter and a number'

export const verifyPassword = (password: string) => {
  if (typeof password !== 'string') return false
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return false
  }
  return /(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])/.test(password)
}
