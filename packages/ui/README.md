# @studafy/ui

The Studafy Design System: design tokens plus the core React component primitives every web
application in the monorepo builds on. It contains no business logic and no application pages.

## Installation

The package is a workspace dependency. Add it to an app's `package.json`:

```json
{ "dependencies": { "@studafy/ui": "workspace:*" } }
```

Then `bun install`, and import the stylesheet **once** at the application root:

```tsx
// apps/web/src/main.tsx
import "@studafy/ui/styles.css";
```

`styles.css` already contains `tokens.css`. Import `@studafy/ui/tokens.css` on its own only if you
want the custom properties for your own markup and no component styles.

```tsx
import { Button, useToast } from "@studafy/ui";
```

## Theming

Tokens are declared on `:root` and re-declared under `:root[data-theme="dark"]`. Switch themes by
setting the attribute on `<html>`; nothing else is required.

```ts
document.documentElement.dataset.theme = "dark"; // or "light"
```

Without the attribute the tokens follow `prefers-color-scheme`. Every token is also exported from
TypeScript (`theme`, `color`, `semanticColor`, `space`, `radius`, `elevation`, `font`) for the rare
case where a value is needed in JS. `src/theme.ts` is the source of truth and `src/tokens.css`
mirrors it — `tokens.consistency.test.ts` fails the build if the two drift apart.

## Components

All components are function components with forwarded refs, fully typed, and exported from the
package root.

### Button

| Prop                           | Type                                     | Default     | Notes                                                                             |
| ------------------------------ | ---------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `variant`                      | `"primary" \| "secondary" \| "tertiary"` | `"primary"` |                                                                                   |
| `loading`                      | `boolean`                                | `false`     | Shows a spinner and blocks interaction; the label stays in the accessibility tree |
| `fullWidth`                    | `boolean`                                | `false`     |                                                                                   |
| `leadingIcon` / `trailingIcon` | `ReactNode`                              | —           | Decorative; mark your own SVGs `aria-hidden`                                      |

Also accepts every native `<button>` attribute except `className`. A loading button is genuinely
unavailable, so it is really `disabled`, not merely styled as such; `aria-busy` is what tells
assistive technology the state is temporary.

```tsx
<Button variant="secondary" loading={saving} onClick={save}>
  Save
</Button>
```

### Input

| Prop                | Type        | Notes                                                    |
| ------------------- | ----------- | -------------------------------------------------------- |
| `label`             | `string`    | Required. There is no unlabelled input                   |
| `helperText`        | `string`    | Wired to the input with `aria-describedby`               |
| `error`             | `string`    | Its **presence** sets the error state and `aria-invalid` |
| `prefix` / `suffix` | `ReactNode` | Decorative adornments                                    |

Controlled and uncontrolled usage both work: pass `value` + `onChange`, or `defaultValue`.
`required` renders the marker and sets `aria-required`.

```tsx
<Input label="Email" type="email" required error={errors.email} suffix="@studafy.com" />
```

### Select

An ARIA 1.2 collapsed listbox — not a native `<select>`. Options are a prop, not children, so the
component owns the `listbox`/`option` structure and the keyboard model.

| Prop                                                         | Type                      | Notes                                                                    |
| ------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------ |
| `label`                                                      | `string`                  | Required                                                                 |
| `options`                                                    | `readonly SelectOption[]` | `{ value, label, disabled? }`                                            |
| `value` / `defaultValue` / `onChange`                        |                           | Controlled or uncontrolled                                               |
| `placeholder`, `helperText`, `error`, `disabled`, `required` |                           |                                                                          |
| `name`                                                       | `string`                  | Renders a hidden input so the value takes part in native form submission |

Keyboard: `↑`/`↓` move, `Home`/`End` jump, `Enter`/`Space` commit, `Escape` closes, `Tab` closes
without selecting, and typing letters jumps to a matching option.

The popup is absolutely positioned inside a relative wrapper, which keeps the package free of a
positioning dependency — at the cost of clipping inside an `overflow: hidden` ancestor.

### Checkbox

`label` is required. `indeterminate` renders the mixed state, which the browser exposes as
`aria-checked="mixed"`. `error` behaves as it does on Input. Controlled and uncontrolled both work.

### Radio

`Radio` must be rendered inside a `RadioGroup`; the shared `name` is what gives the group its
native arrow-key navigation. The group carries the label, error, and disabled state.

```tsx
<RadioGroup label="Difficulty" name="difficulty" defaultValue="easy" onChange={setLevel}>
  <Radio value="easy" label="Easy" />
  <Radio value="hard" label="Hard" disabled />
</RadioGroup>
```

### Chip

`variant` is `"filled"` or `"outlined"`. Passing `onRemove` renders a remove button — the chip body
itself stays a non-interactive `<span>`, because a clickable chip wrapping a remove button would
nest one control inside another. `removeLabel` overrides the generated accessible name.

### Card

`Card`, `CardHeader`, `CardBody`, `CardFooter`. `elevation` is `0 | 1 | 2 | 3 | 4` (tonal), `as`
picks the element (`div` | `article` | `section`).

`interactive` adds hover and active affordances but keeps the card a plain container. Give the
single primary control inside it the `sf-card__action` class; its `::after` covers the whole card
surface, so the entire card is clickable while exactly one control exists in the accessibility
tree. **Never** make the card itself a button — a button cannot contain other controls.

```tsx
<Card interactive elevation={1}>
  <CardHeader>
    <h3>Algebra</h3>
  </CardHeader>
  <CardBody>12 lessons</CardBody>
  <CardFooter>
    <a className="sf-card__action" href="/algebra">
      Open
    </a>
  </CardFooter>
</Card>
```

### Modal

Portalled `role="dialog"` with `aria-modal`. Focus moves in on open, `Tab`/`Shift+Tab` wrap inside,
and focus returns to the previously focused element on close. `Escape` and overlay clicks dismiss
unless `closeOnEsc` / `closeOnOverlayClick` are `false`. An overlay click only counts when the
gesture starts _and_ ends on the overlay, so dragging out of the dialog cannot dismiss it.

| Prop              | Type                     | Notes                                     |
| ----------------- | ------------------------ | ----------------------------------------- |
| `open`            | `boolean`                | Required                                  |
| `onClose`         | `() => void`             | Required                                  |
| `title`           | `string`                 | Names the dialog; rendered as its heading |
| `description`     | `string`                 | Wired with `aria-describedby`             |
| `initialFocusRef` | `RefObject<HTMLElement>` | Defaults to the first focusable element   |

On a destructive dialog, point `initialFocusRef` at the _non_-destructive action.

### Toast

Mount `ToastProvider` once at the application root; fire toasts with `useToast()`.

```tsx
<ToastProvider duration={5000}>
  <App />
</ToastProvider>;

const { show, dismiss } = useToast();
const id = show({ variant: "success", title: "Saved", description: "Your changes are live." });
```

`variant` is `"success" | "error" | "warning" | "info"` (default `"info"`). `duration` overrides the
provider default per toast; `0` disables auto-dismiss, leaving only the dismiss button. `show`
returns an id for `dismiss(id)`.

Errors and warnings are announced assertively (`role="alert"`); successes and info wait for a pause
in speech (`role="status"`).

### Tabs

Compound: `Tabs`, `Tabs.List`, `Tabs.Tab`, `Tabs.Panel`. Controlled with `value` + `onChange`, or
uncontrolled with `defaultValue` (always required, so a panel is selected on first paint).
`orientation` is `"horizontal"` (default) or `"vertical"`.

Keyboard follows the ARIA tabs pattern with automatic activation: arrow keys move focus _and_
selection, `Home`/`End` jump to the first/last enabled tab, and disabled tabs are skipped. Only the
selected tab is in the page tab order (roving tabindex).

```tsx
<Tabs defaultValue="lessons" onChange={setTab}>
  <Tabs.List>
    <Tabs.Tab value="lessons">Lessons</Tabs.Tab>
    <Tabs.Tab value="grades" disabled>
      Grades
    </Tabs.Tab>
  </Tabs.List>
  <Tabs.Panel value="lessons">…</Tabs.Panel>
</Tabs>
```

### Table

`Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHeaderCell`, `TableCell`.

`caption` is required and names both the table and its horizontally scrollable container;
`hideCaption` keeps it for assistive technology only. `TableBody` takes `columnCount` plus
`loading` and `empty`, which it uses to span a busy placeholder or an empty state across the table.

```tsx
<Table caption="Enrolled students">
  <TableHeader>
    <TableRow>
      <TableHeaderCell>Name</TableHeaderCell>
    </TableRow>
  </TableHeader>
  <TableBody columnCount={1} loading={isLoading} empty={<p>No students yet.</p>}>
    {rows.map((r) => (
      <TableRow key={r.id}>
        <TableCell>{r.name}</TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

## Accessibility guidelines

Every component targets **WCAG 2.2 AA** and is covered by an `axe-core` assertion in its test file.

- Labels are required props, not optional ones. A component that cannot be named is not shipped.
- Focus is always visible: the ring is `--focus-ring-*` and is applied on `:focus-visible`.
- `disabled` removes a control from the tab order; the _error_ state never does.
- Error text is linked with `aria-describedby` and the control gets `aria-invalid`.
- Motion honours `prefers-reduced-motion`: the duration tokens collapse to `1ms`.

Colour contrast is **not** checked by axe in unit tests — happy-dom has no layout or cascade, so
axe cannot sample painted pixels. It is enforced one level lower, at the source of truth:
`theme.contrast.test.ts` checks every semantic text/background pair in both themes against AA.
That is a stronger guarantee than sampling whatever a story happened to render.

## Design guidelines

- **8px** control spacing, **16px** card padding.
- Never hardcode a colour, space, radius, shadow, font, or duration. Every value comes from a
  token: `var(--space-8)`, `var(--color-accent)`, `var(--elevation-2)`, `var(--duration-fast)`.
  A `var(--…)` that does not exist fails `tokens.consistency.test.ts`.
- Elevation is tonal. Prefer a lower elevation and a border over a heavy shadow.

## Styling conventions

- Class names are BEM under an `sf-` prefix: `sf-toast`, `sf-toast__title`, `sf-toast--error`.
- Components accept no `className` prop. Composition is done with wrappers and the documented hook
  classes (`sf-card__action`), not by leaking internals. This keeps the DOM contract stable.
- Components never import their own CSS. `src/styles.css` aggregates every stylesheet in cascade
  order — tokens, utilities, shared field chrome, then components. The package is built with `tsc`
  (preserving modules for tree-shaking), which emits JavaScript only, so a `.css` import inside a
  component would not survive the build.

## Composition

Prefer composing primitives over adding props.

```tsx
function DeleteCourseDialog({ open, onClose, onConfirm }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { show } = useToast();

  return (
    <Modal open={open} onClose={onClose} title="Delete course" initialFocusRef={cancelRef}>
      <Modal.Body>This cannot be undone.</Modal.Body>
      <Modal.Footer>
        <Button ref={cancelRef} variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            onConfirm();
            show({ variant: "success", title: "Deleted" });
          }}
        >
          Delete
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
```

## Best practices

- Import from the package root (`@studafy/ui`), never from `dist/` or `src/`.
- Keep business logic in the app. These primitives hold UI state only.
- Reach for a token before writing a raw value, and a primitive before writing a new component.
- Treat an `error` string as the single source of the error state — do not pair it with a separate
  boolean.

## Development

```bash
bun test              # unit + axe assertions
bun run check-types
bun run lint
bun run build         # tsc → dist, preserving modules
bun run storybook     # http://localhost:6006
bun run build-storybook
```

Storybook is the component documentation: every component has stories for its default, focus, and
dark-theme states, plus an interactive example, and — where the component has them — disabled,
error, loading, and size variants. The `@storybook/addon-a11y`
panel runs axe against the rendered story in a real browser, which is where the contrast and layout
checks that happy-dom cannot perform actually happen.

### Local ESLint config

`packages/config`'s README asks that any local `eslint.config.js` be justified in its package's
README. This package has one for a single reason: the shared preset targets Node, so the browser
globals these components rely on (`document`, `window`, `KeyboardEvent`) would trip `no-undef`. No
rule is relaxed.

The `lint` script passes `--ignore-pattern storybook-static` because `build-storybook` writes
minified bundles into the package, and linting build output is meaningless.
