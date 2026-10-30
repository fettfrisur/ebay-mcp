#!/usr/bin/env python3
"""Verify the recovered source history using only Python and Git."""

from datetime import datetime
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def main():
    history = json.loads((ROOT / 'docs/history/cloudflare-versions.json').read_text())
    commits = history['code_commits']
    versions = history['versions']
    require(len(versions) == 14, 'Expected the 14 recovered Cloudflare versions')
    require(len(commits) == 7, 'Expected seven distinct recovered code states')
    previous = history['preserved_initial_commit']
    last_observed = None
    for record in commits:
        sha = record['commit']
        parent = git('rev-parse', sha + '^').decode().strip()
        require(parent == previous, f'Unexpected parent for {sha}')
        source = next(v for v in versions if v['number'] == record['cloudflare_number'])
        observed = datetime.fromisoformat(source['created_on'].replace('Z', '+00:00'))
        require(last_observed is None or observed > last_observed, 'Source snapshots are out of order')
        actual_date = int(git('show', '-s', '--format=%at', sha))
        require(actual_date == int(observed.timestamp()), f'Historical author date mismatch: {sha}')
        committed = int(git('show', '-s', '--format=%ct', sha))
        imported = datetime.fromisoformat(history['imported_at'])
        require(committed >= int(imported.timestamp()), f'Committer date predates recovery: {sha}')
        message = git('show', '-s', '--format=%B', sha).decode()
        require('Reconstructed-History: true' in message, f'Missing reconstruction label: {sha}')
        require('Snapshot-Date: ' + source['created_on'] in message, f'Missing precise timestamp: {sha}')
        require('Source-SHA256: ' + source['modules'][0]['sha256'] in message, f'Missing source hash: {sha}')
        previous = sha
        last_observed = observed

    for version in versions:
        require(len(version['modules']) == 1, 'Unexpected module layout')
        module = version['modules'][0]
        raw = git('show', version['source_commit'] + ':' + module['name'])
        require(len(raw) == module['byte_length'], f'Byte count mismatch: Cloudflare {version["number"]}')
        require(hashlib.sha256(raw).hexdigest() == module['sha256'], f'Hash mismatch: Cloudflare {version["number"]}')

    current = (ROOT / 'worker.js').read_bytes()
    active = json.loads((ROOT / 'docs/history/active-source-check.json').read_text())
    require(len(active['versions']) == 1, 'Expected one active source version')
    live = active['versions'][0]
    require(live['percentage'] == 100, 'Expected the recorded active version to serve all traffic')
    require(hashlib.sha256(current).hexdigest() == live['modules'][0]['sha256'], 'worker.js differs from the recorded live source')
    require(current == git('show', commits[-1]['commit'] + ':worker.js'), 'Current source differs from final recovered code commit')
    require((ROOT / 'LICENSE').read_bytes() == git('show', history['preserved_initial_commit'] + ':LICENSE'), 'Original license changed')
    print('Verified: 14 versions, 7 chronological source commits, author/committer dates, source checksums, original license, and recorded live source.')


if __name__ == '__main__':
    main()
