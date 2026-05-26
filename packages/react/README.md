# @chatroy/react

React components for Roy chat applications.

## Install

```bash
pnpm add @chatroy/react @chatroy/core react react-dom
```

Roy React components render shadcn/Tailwind-compatible class names. They do not
ship a CSS bundle; bring your own design system tokens/classes.

## Components

```tsx
import {
  ChatWindow,
  CompactionBanner,
  ModelPicker,
  PlanApproval,
  SessionRolloverAlert,
} from '@chatroy/react'
```

- `ChatWindow`: message list, streaming text, input box, and simple cost display.
- `ModelPicker`: grouped model selector using Roy model metadata.
- `CompactionBanner`: transient context compaction notification.
- `SessionRolloverAlert`: session rollover callout.
- `PlanApproval`: renders a Roy `PlanDocument` from `approval-requested` for
  approval or rejection.

## Example

```tsx
import { ChatWindow } from '@chatroy/react'

export function App({ messages, send }) {
  return <ChatWindow messages={messages} agentName="Assistant" onSend={(input) => send(input)} />
}
```

## Security

Components render text through normal React interpolation. They do not use
`dangerouslySetInnerHTML`.

## Published Artifacts

This package intentionally publishes `dist`, `src`, declaration maps, and
JavaScript source maps.

## License

MIT
