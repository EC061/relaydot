# Publishing the Python agent with uv

The package source is `agent/`. Version `0.1.x` publishes the tested local
agent-core primitives and CLI only; it is not the complete Relaydot sync client.

## One-time setup

1. Confirm that the `relaydot` project name is still available on PyPI.
2. Create a protected GitHub environment named `pypi`, ideally with required
   reviewers.
3. In the PyPI project's **Publishing** settings, add a GitHub Trusted Publisher
   for this repository with:
   - workflow: `release.yml`
   - environment: `pypi`
4. Confirm the repository owner and repository name exactly match the PyPI
   publisher configuration.

The release workflow uses short-lived OIDC credentials; it does not need a stored
PyPI API token.

## Prepare and verify a release

Run from the repository root:

```sh
cd agent
uv sync --all-groups --locked --python 3.11
uv run ruff check .
uv run ruff format --check .
uv run mypy src
uv run pytest --cov=relaydot --cov-report=term-missing

# Pick the appropriate bump: patch, minor, or major.
uv version --bump patch

rm -rf dist
uv build --no-sources
uv run --isolated --no-project --with dist/*.whl python tests/smoke_package.py
uv run --isolated --no-project --with dist/*.tar.gz python tests/smoke_package.py
```

Review and commit the `pyproject.toml` and `uv.lock` version changes. The CLI
reads its installed version from package metadata, so there is no second version
constant to update.

## TestPyPI dry run

Create a TestPyPI token and publish explicitly:

```sh
cd agent
export UV_PUBLISH_TOKEN='pypi-...'
uv publish \
  --publish-url https://test.pypi.org/legacy/ \
  --check-url https://test.pypi.org/simple/ \
  dist/*
unset UV_PUBLISH_TOKEN
```

Install the uploaded version without consulting PyPI for Relaydot itself:

```sh
uv tool install \
  --index https://test.pypi.org/simple/ \
  --default-index https://pypi.org/simple/ \
  relaydot==<version>
relaydot --version
relaydot config validate
uv tool uninstall relaydot
```

TestPyPI may not mirror dependencies reliably. If dependency resolution fails,
the local wheel and source-distribution smoke tests above remain the authoritative
artifact checks.

## Publish to PyPI

The normal release path is the tag-triggered workflow:

```sh
git tag -a v<version> -m "Relaydot v<version>"
git push origin v<version>
```

The workflow refuses to publish when the tag (without `v`) differs from the
package version, repeats the locked lint/type/test suite, rebuilds both
distributions, smoke-tests both artifacts, and runs `uv publish` through PyPI
Trusted Publishing.

For an emergency manual publish with a project-scoped PyPI token:

```sh
cd agent
export UV_PUBLISH_TOKEN='pypi-...'
uv publish --check-url https://pypi.org/simple/ dist/*
unset UV_PUBLISH_TOKEN
```

PyPI versions are immutable. If a release is wrong, bump the version and publish
a new release; do not rebuild different files under the same version.

## Post-publish check

```sh
uv tool install relaydot==<version>
relaydot --version
relaydot doctor
relaydot config validate
uv tool uninstall relaydot
```
