import fs from 'fs'
import path from 'path'
import { v4 } from 'uuid'

const userFilesDir = 'user-files'

const resolvePath = (_path: string, dirDepth: string) => {
  return path.resolve(__dirname, dirDepth, _path)
}

/**
 * Every path this module produces must land inside `user-files`.
 *
 * `name`, `resolution` and `_path` all reach here straight from a request
 * body, and all three are concatenated into a path: `_path` picks the
 * directory, `name` opens the filename, and `resolution` closes it after a
 * dot — so `resolution = '../../x'` escapes just as readily as a `../` in
 * `_path` does. Checking the inputs one by one means the next argument that
 * gets threaded in here is unguarded again, so the check is on the resolved
 * result instead: whatever the inputs were, the directory we create and the
 * file we write both have to still be under the root.
 */
const assertInside = (root: string, target: string) => {
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Refusing to write outside the user-files directory')
  }
}

const saveFile = (
  data: string,
  name: string,
  resolution?: string,
  _path?: string,
  dirDepth = '../../../',
) => {
  const root = resolvePath(userFilesDir, dirDepth)
  const pathToUse = _path ? `${userFilesDir}/${_path}` : userFilesDir
  const fullPath = resolvePath(pathToUse, dirDepth)
  // Before mkdir: a traversing `_path` would otherwise create directories
  // anywhere the process can write, whether or not the write below lands.
  assertInside(root, fullPath)
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true })
  }
  const fileName = `${name}-${v4()}.${resolution}`
  const pathWithName = path.resolve(fullPath, fileName)
  assertInside(root, pathWithName)
  fs.writeFileSync(`${pathWithName}`, data, 'utf-8')
  const size = fs.statSync(`${pathWithName}`).size
  return { path: pathWithName, name: fileName, size }
}

/**
 * Is `candidate` a path this module would have produced?
 *
 * The read side needs the same answer the write side enforces, from the same
 * root, or the two drift apart. `saveFile` bounds what it writes, but rows
 * stored before that guard existed are still in the database and are still
 * handed to `res.sendFile()` — so the serving path has to re-check rather than
 * trust the stored value (GHSA / main-app-sh PR #12).
 *
 * `dirDepth` must match what the caller passed to `saveFile`.
 */
export const isInsideUserFiles = (
  candidate: string,
  dirDepth = '../../../',
): boolean => {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const root = resolvePath(userFilesDir, dirDepth)
  const target = path.resolve(candidate)
  return target === root || target.startsWith(root + path.sep)
}

export default saveFile
