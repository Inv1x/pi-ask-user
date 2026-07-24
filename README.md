# pi-ask-user

A standalone [`ask_user`](https://github.com/earendil-works/pi) tool for Pi 0.81.1. It lets the model ask one multiple-choice question in the TUI while always preserving a free-form answer path.

## Behavior

- Accepts exactly 2–5 model-provided options, each with a label and optional description.
- Appends **Write my own answer…** automatically.
- Uses Up/Down with wraparound, number keys for direct selection, Enter to confirm, and Esc to dismiss.
- Opens an inline editor for a custom answer. Blank submissions and Esc return to the options; nonblank answers are trimmed and submitted.
- Runs tool calls sequentially so multiple questions cannot open competing interactive views.
- Treats an aborted tool signal as cancellation and removes its listener when the view settles or is disposed.
- In non-TUI modes, tells the model that no interactive UI is available and to ask in plain text.
- Returns structured details containing the question, option labels, answer, whether it was custom, and whether the interaction was cancelled or dismissed.

The tool prompt encourages Pi to use `ask_user` for enumerable choices and to ask only one question per call.

## Install

From this repository:

```bash
npm install
pi -e .
```

Or add the absolute package path to Pi's package settings.

## Development

```bash
npm install
npm run check
npm run typecheck
npm test
npm pack --dry-run
```

The implementation targets Pi 0.81.1 and uses native promises and `AbortSignal`; it has no Effect dependency.

## Credits

Behavior and UI are based on the [`ask-user`](https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/ask-user) extension from `davis7dotsh/my-pi-setup`.

## License

MIT
