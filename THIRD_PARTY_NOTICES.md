# Third-party notices

Cairn is licensed under `AGPL-3.0-only` (see [LICENSE](LICENSE)). The material
listed here was written by others, is included in or modifies this repository,
and stays under its own license. Keep each notice when you copy or move the
material.

## Effect UI

The viewer is built with [Effect UI](https://github.com/Effect-TS/ui)
(`@effect/ui` and `@effect/ui-kit`), which is installed from npm and bundled
into the viewer deployed to prdtrace.com. It is distributed under this license:

```text
MIT License

Copyright (c) 2023 Effectful Technologies Inc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ratstack reference material

`.agent_sources/ratstack/` holds offline copies of Ratstack material that
agents read while working on Cairn. It is reference material, not part of
Cairn's code, and is not covered by Cairn's license.

- `.agent_sources/ratstack/source/` is copied from the rat-stack repository
  under the MIT License, Copyright (c) 2026 Joel Hooks; the full text is in
  [.agent_sources/ratstack/source/LICENSE](.agent_sources/ratstack/source/LICENSE).
- `.agent_sources/ratstack/source/skills/rat-stack-mode/` also carries the
  MIT License, Copyright (c) 2026 Lauren Tan, in
  [LICENSE-pstack](.agent_sources/ratstack/source/skills/rat-stack-mode/LICENSE-pstack).
- `.agent_sources/ratstack/guide.txt` and `docs.txt` are snapshots of
  <https://ratstack.sh/llms.txt> and <https://ratstack.sh/llms-full.txt>
  (sources and hashes in [.agent_sources/sources.json](.agent_sources/sources.json)).
  They remain the work of their authors under whatever terms the site applies;
  see [LICENSING.md](LICENSING.md#open-legal-questions).

## npm dependencies

Dependencies installed from npm are not committed here; each package carries
its own license and notices. [LICENSING.md](LICENSING.md#dependency-audit)
lists them by license. A build that bundles dependencies, such as the viewer
deployed to prdtrace.com, has to ship their notices with it.
