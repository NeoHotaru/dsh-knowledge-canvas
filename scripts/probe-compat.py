# -*- coding: utf-8 -*-
"""Which published DSH versions expose every member this plugin uses.

DSH publishes its whole monorepo at one version, so `dsh@X` pins `dsh-tools@X` and friends. The probe is
therefore a straight walk over published `dsh` versions: fetch the tarballs of the packages this plugin
touches, concatenate their type declarations, and ask which of the members are present.

Two things the first version of this probe got wrong, both of which produced a confident wrong answer:

  * `dist-tags.latest` for these packages is `0.0.1-rc.1` — far behind the app, which runs `0.2.0-rc.2`.
    Reading `latest` would have measured the wrong end of the range entirely.
  * A version whose declarations could not be fetched is reported as NO DATA, never as a pass.

Run:  python probe-compat.py [--from <version>]
"""
import argparse
import io
import json
import re
import sys
import tarfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor

REG = 'https://registry.npmjs.org'

# What this plugin touches. Grouped by the package that declares it, because a member only counts if it is
# present in *its own* package.
MEMBERS = {
    '@deepseek-ai/dsh-tools': ['register', 'post-execute'],
    '@deepseek-ai/dsh-system-prompt': ['section', 'context'],
    '@deepseek-ai/dsh-session': ['get'],
}


def fetch(url, binary=False):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read() if binary else response.read().decode('utf-8')


def versions():
    """The version list to walk.

    Anchored on `@deepseek-ai/dsh-tools`, not on `dsh`: the `dsh` package on npm publishes under a different
    scheme and has only two versions (1.0.0, 1.0.1), while the app runs 0.2.0-rc.2 and `dsh-tools` has the
    real series. Anchoring on `latest` is worse still — that tag sits at 0.0.1-rc.1, far behind the app.
    """
    meta = json.loads(fetch('%s/%s' % (REG, '@deepseek-ai%2Fdsh-tools')))
    return sorted(meta['versions'], key=lambda v: [int(p) if p.isdigit() else p
                                                   for p in re.split(r'[.\-]', v)])


def pin(version):
    """The tarballs for one DSH version, or None when that version has no matching packages."""
    out = {}
    for package in MEMBERS:
        try:
            meta = json.loads(fetch('%s/%s/%s' % (REG, package.replace('/', '%2F'), version)))
            out[package] = meta['dist']['tarball']
        except Exception:
            return None
    return out


def declarations(tarball):
    blob = fetch(tarball, binary=True)
    text = []
    with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
        for member in tar.getmembers():
            if member.name.endswith(('.d.ts', '.d.mts')):
                handle = tar.extractfile(member)
                if handle:
                    text.append(handle.read().decode('utf-8', errors='replace'))
    return '\n'.join(text)


def check(version):
    try:
        pins = pin(version)
        if pins is None:
            return version, None, ['(packages not published at this version)']
        missing = []
        for package, members in MEMBERS.items():
            text = declarations(pins[package])
            for name in members:
                if not re.search(r'\b%s\b' % re.escape(name), text):
                    missing.append('%s.%s' % (package.split('/')[-1], name))
        return version, (len(missing) == 0), missing
    except Exception as error:
        return version, None, ['NO DATA: %s' % error]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--from', dest='start', default=None)
    args = parser.parse_args()

    all_versions = versions()
    if args.start:
        all_versions = [v for v in all_versions if v >= args.start]
    print('  walking %d published dsh versions' % len(all_versions))

    results = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for version, ok, missing in pool.map(check, all_versions):
            results.append((version, ok, missing))

    results.sort(key=lambda row: [int(p) if p.isdigit() else p for p in re.split(r'[.\-]', row[0])])
    for version, ok, missing in results:
        mark = 'OK' if ok else ('NO DATA' if ok is None else 'missing')
        print('  %-18s %-8s %s' % (version, mark, ', '.join(missing[:4])))

    passing = [v for v, ok, _ in results if ok]
    print()
    if passing:
        print('  first version with every member present: %s' % passing[0])
    else:
        print('  NO VERSION has every member present')
    print('  versions with no data: %d' % sum(1 for _, ok, _ in results if ok is None))


main()
