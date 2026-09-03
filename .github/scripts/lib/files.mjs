// Shared file-list reader.
//
// Paths arrive NUL-delimited on stdin, from `git -c core.quotePath=false
// ls-files -z`. Both halves of that matter: without -z a path containing a
// space is word-split by the shell and silently dropped (this repo already
// has "ONEST Ecosystem-7.jpg"), and without quotePath=false git renders a
// non-ASCII path as an escaped quoted string that then fails to open — which
// would report a valid file as invalid.
export async function fileList(argv = process.argv.slice(2)) {
  const paths = argv.filter((a) => !a.startsWith('--'));
  if (paths.length > 0) return paths;
  if (process.stdin.isTTY) return [];
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
}
