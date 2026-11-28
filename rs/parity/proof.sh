#!/bin/sh
# Every proof that the binary behaves like src/index.ts, in one go, on
# Linux, macOS or Windows (in Git Bash there):
#
#   sh rs/parity/proof.sh <rustify's templates/parity/parity.mjs> <the winrpc binary>
#
# from the repository root, after `bun install`. The CI workflow's parity job
# runs this on each platform of `parity-platforms`, against the binary it has
# just built for that platform ($RUSTIFY_PLATFORM names it; without it,
# `uname` does).
#
# First rs/parity.json is checked to be what rs/parity.gen.mjs writes, and
# rs/src/testdata/vectors.json what rs/vectors.gen.mjs records from this
# bun. Then these run side by side, each into a log of its own:
#
#   lane<n>   rs/parity.json split into lanes (rs/parity/lanes.mjs), every
#             lane run two or three times, every case behind the stand-in
#             server of rs/parity/with-mock.mjs:
#             - TypeScript against the binary (the binary may hand back to
#               the real package);
#             - the binary alone against a stand-in package, which fails
#               unless exactly the cases marked "handback" for this system
#               reach the JavaScript;
#             - on Linux and macOS, TypeScript against the binary again with
#               standard output and standard error on a terminal (`--tty
#               stdout,stderr`), where bun colours console.error and yargs
#               wraps at the terminal's width, so the binary hands most of
#               it back: what it still answers there has to be the same.
#             As many lanes as the machine has processors, at most 3 on
#             Windows (PARITY_LANES says otherwise).
#   unit      cargo test in rs/, on macOS and Windows (on Linux the workflow
#             has a job of its own for it). It builds the crate again from
#             the same sources; it does not run the binary named above.
#
# There is no terminal on Windows (python's pty is for Linux and macOS):
# there the cases that need one are skipped, as rs/parity.gen.mjs says, and
# the terminal run is left out.
#
# At the end one line is printed for each that passed, and all of what a
# failed one wrote. The exit code is 0 only when all of them passed.
set -u
usage="usage: proof.sh <parity.mjs> <binary>"
# In Git Bash `pwd -W` gives a directory as Windows programs (node, the
# binary) read it.
here=$(pwd -W 2> /dev/null || pwd)
absolute() {
  case "$1" in
    /* | [A-Za-z]:[\\/]*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$here" "$1" ;;
  esac
}
runner=$(absolute "${1:?$usage}")
binary=$(absolute "${2:?$usage}")
# In Git Bash, one spelling (C:/…/x) that node, the binary and the shell all
# read alike, whatever mix of slashes the workflow's variables have.
if command -v cygpath > /dev/null 2>&1; then
  runner=$(cygpath -m "$runner")
  binary=$(cygpath -m "$binary")
fi
cd "$(dirname "$0")/../.." || exit 1
root=$(pwd -W 2> /dev/null || pwd)

platform=${RUSTIFY_PLATFORM:-}
if [ -z "$platform" ]; then
  case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    MINGW* | MSYS* | CYGWIN*) platform=win32 ;;
    *) platform=$(uname -s) ;;
  esac
fi
processors=$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo "${NUMBER_OF_PROCESSORS:-2}")
case "$platform" in
  win32*)
    others="unit" left_out="tty"
    [ "$processors" -gt 3 ] && processors=3
    ;;
  darwin*) others="unit" left_out="" ;;
  *) others="" left_out="unit" ;;
esac
lanes=${PARITY_LANES:-$processors}

node rs/parity.gen.mjs --check || exit 1
bun rs/vectors.gen.mjs --check || exit 1

# In $TMPDIR, which macOS's mktemp passes over without a template.
logs=$(mktemp -d "${TMPDIR:-/tmp}/winrpc-proof.XXXXXX") || exit 1
logs_for_node=$(cygpath -m "$logs" 2> /dev/null || printf '%s' "$logs")
node rs/parity/lanes.mjs rs/parity.json "$lanes" "$logs_for_node" || exit 1

start() {
  name=$1
  shift
  (
    "$@" > "$logs/$name.log" 2>&1
    echo $? > "$logs/$name.exit"
  ) &
}
ts="node rs/parity/with-mock.mjs bun src/index.ts"
lane() {
  cases=$logs_for_node/lane-$1.json
  code=0
  node "$runner" --cases "$cases" --ts "$ts" --rs "env WINRPC_PACKAGE_ROOT=$root node rs/parity/with-mock.mjs $binary" || code=1
  node "$runner" --cases "$cases" --rs "node rs/parity/with-mock.mjs $binary" --handback WINRPC_PACKAGE_ROOT=src/index.ts || code=1
  case "$platform" in
    win32*) ;;
    *)
      echo "--- on a terminal (--tty stdout,stderr)"
      node "$runner" --cases "$cases" --tty stdout,stderr --ts "$ts" --rs "env WINRPC_PACKAGE_ROOT=$root node rs/parity/with-mock.mjs $binary" || code=1
      ;;
  esac
  return $code
}
runs=""
n=0
while [ "$n" -lt "$lanes" ]; do
  start "lane$n" lane "$n"
  runs="$runs lane$n"
  n=$((n + 1))
done
for name in $others; do
  case $name in
    unit) start unit cargo test --release --locked --manifest-path rs/Cargo.toml ;;
  esac
  runs="$runs $name"
done
wait

echo "proof on $platform with bun $(bun --version), $lanes lane(s):$runs"
failed=0
same=0 native=0 back=0 terminal=0
for name in $runs; do
  code=$(cat "$logs/$name.exit" 2> /dev/null || echo "no exit code")
  if [ "$code" != 0 ]; then
    echo "$name: FAILED ($code)"
    cat "$logs/$name.log"
    failed=1
    continue
  fi
  case $name in
    lane*)
      # The first "all N behave the same" is the plain run, a second one
      # the run on a terminal.
      counts=$(sed -n 's/^all \([0-9]*\) case(s) behave the same$/\1/p' "$logs/$name.log")
      first=$(printf '%s\n' "$counts" | sed -n 1p)
      second=$(printf '%s\n' "$counts" | sed -n 2p)
      same=$((same + ${first:-0}))
      terminal=$((terminal + ${second:-0}))
      count=$(sed -n 's/^\([0-9]*\) case(s) answered by the binary, .*/\1/p' "$logs/$name.log")
      native=$((native + count))
      count=$(sed -n 's/^.* answered by the binary, \([0-9]*\) handed back .*/\1/p' "$logs/$name.log")
      back=$((back + count))
      ;;
    unit) grep '^test result' "$logs/$name.log" | sed "s/^/$name: /" ;;
  esac
done
if [ "$failed" = 0 ]; then
  echo "parity: all $same case(s) behave the same; $native answered by the binary, $back handed back to the JavaScript, as the cases say"
  case "$platform" in
    win32*) ;;
    *) echo "parity on a terminal: all $terminal case(s) behave the same" ;;
  esac
  # Each run of each lane names the cases skipped here, and why (every run
  # of a lane skips the same ones): the reasons, summed.
  runs_per_lane=3
  case "$platform" in
    win32*) runs_per_lane=2 ;;
  esac
  tab=$(printf '\t')
  cat "$logs"/lane*.log | sed -n "s/^ *\([0-9][0-9]*\)  \(.*\)\$/\1$tab\2/p" | sort -t "$tab" -k 2 | awk -F "$tab" '
    $2 != reason { if (reason != "") print total "\t" reason; reason = $2; total = 0 }
    { total += $1 }
    END { if (reason != "") print total "\t" reason }' | while IFS="$tab" read -r total reason; do
    echo "  skipped on $platform: $((total / runs_per_lane))  $reason"
  done
fi
for name in $left_out; do
  case $name in
    unit) echo "unit: not here (the workflow's cargo test job runs it on Linux)" ;;
    tty) echo "tty: not here (no pseudo-terminal on Windows)" ;;
  esac
done
rm -rf "$logs"
exit $failed
