# Standard-library fallbacks

Decky Loader's frozen Windows Python (PyInstaller, Python 3.14) only bundles the standard-library modules Decky
itself imports. `html.parser` and `_markupbase` are not among them, so `gamebanana.py` loads these copies when the
real modules are missing.

- `html_parser.py`: CPython 3.13.18 `Lib/html/parser.py`, unmodified.
- `_markupbase.py`: CPython 3.13.18 `Lib/_markupbase.py`, unmodified.

Both are under the Python Software Foundation License (https://docs.python.org/3/license.html).
