# pi-ask-user

A standalone [`ask_user`](https://github.com/earendil-works/pi) tool for Pi. It lets the model ask one multiple-choice question in the TUI while always preserving a free-form answer path.

## Behavior

- Accepts exactly 2–5 model-provided options, each with a label and optional description.
- Appends **Write my own answer…** automatically.
- Uses Pi's configured `tui.select.up`, `tui.select.down`, `tui.select.confirm`, and `tui.select.cancel` keybindings. Number keys remain direct-selection shortcuts.
- Opens an inline editor for a custom answer. Blank submissions and the configured cancel key return to the options; nonblank answers are trimmed and submitted.
- Runs tool calls sequentially so multiple questions cannot open competing interactive views.
- Treats an aborted tool signal as cancellation and removes its listener whenever the view settles or is disposed.
- Wraps ANSI-styled text by terminal display width, including CJK and emoji, and safely rerenders when the TUI width changes (including fullscreen mode).
- Removes terminal escape sequences, unsafe control characters, and bidirectional overrides from model-provided display text.
- Requests strict JSON Schema constrained sampling when the active model supports it, while falling back normally on models that do not.
- In non-TUI modes, tells the model that no interactive UI is available and to ask in plain text.
- Returns structured details containing the question, option labels, answer, whether it was custom, and whether the interaction was cancelled or dismissed.

The tool prompt encourages Pi to use `ask_user` for enumerable choices and to ask only one question per call.

## Install

Install from npm:

```bash
pi install npm:@inv1x/pi-ask-user
```

For local development, install this checkout persistently so `/reload` can rediscover it:

```bash
npm install
pi install /absolute/path/to/pi-ask-user
```

Use `pi -e .` only for a temporary development smoke test. You can also add the absolute package path to Pi's package settings.

## Compatibility

The current release is developed and tested against Pi **0.84.1** (the tested minimum) and Node.js 22.19 or newer. Pi-bundled runtime modules (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) remain unbundled peer dependencies so the extension uses the host Pi runtime.

## Development

```bash
npm install
npm run format
npm run check
npm run typecheck
npm test
npm pack --dry-run
```

`npm pack` runs the same check, typecheck, and test quality gate automatically through `prepack`.

## Credits

Behavior and UI are based on the [`ask-user`](https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/ask-user) extension from `davis7dotsh/my-pi-setup`.

## License

MIT
