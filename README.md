# Incremental TD Skill Tree Builder

A responsive React Flow editor for authoring spatial, directed skill trees for an incremental tower-defense game.

## Graph interactions

- Drag a circle normally to reposition it. Node positions are persisted and exported for direct in-game placement.
- Hold **Alt** and **left-drag from anywhere on a circle to anywhere on another circle** to create a directed prerequisite link. The start node is the prerequisite; the end node is unlocked by it.
- Hold **Ctrl** and **left-drag from a node** to create a new blank child at the drop position. It is linked automatically from the source node.
- Hold **Ctrl** and **right-drag from a node** to create an upgrade-copy child at the drop position. It copies the source cost and upgrade effects, then increments a trailing number in the name (`Damage 2` → `Damage 3`) or appends ` 2` when there is no trailing number.
- **Middle-click a node** to duplicate it nearby with the same data and the same incoming parent/prerequisite links.
- Select one or more nodes (use **Shift** for multi-selection), then press **Ctrl+C** to copy them. **Ctrl+V** pastes the copied subgraph and preserves external parent links for the root-most copied nodes. **Ctrl+Shift+V** pastes only the copied nodes and links between them, creating a standalone island. Relative positions are preserved.
- **Right-drag** the graph to pan. Right-dragging directly on a node also pans unless Ctrl is held, in which case it keeps the upgrade-copy gesture described above.
- Links render as straight arrows. Their endpoints are calculated from the two circle centers so they meet the circumference along the shortest line instead of using fixed left/right anchors.
- Links are validated as a DAG. Self-links, duplicate links, and links from descendants back to their ancestors are blocked. Multiple parents and multiple children are supported.

## Editor features

- Persistent Inspector for name, typed currency cost, exact X/Y position, upgrade effects, and prerequisites.
- Configurable stat pool with `number` and `boolean` definitions.
- Configurable currency pool with display name, stable game key, and display symbol.
- Type-safe effect operators:
  - Number: `add`, `subtract`, `multiply`, `divide`
  - Boolean: `set` with `true`/`false`
- Browser autosave via `localStorage`.
- JSON project import/export.
- Version-1 project migration: old numeric costs are automatically assigned to the default currency.
- Imported edges are sanitized so cyclic, duplicate, self-referential, or dangling links are not loaded.
- Responsive desktop and mobile layouts.

## Run

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

## Export shape

```ts
{
  version: 2,
  nodes: [
    {
      id: string,
      type: "skill",
      position: { x: number, y: number },
      data: {
        name: string,
        cost: {
          currencyId: string,
          amount: number
        },
        upgrades: [
          {
            id: string,
            statId: string,
            operator: "add" | "subtract" | "multiply" | "divide" | "set",
            value: number | boolean
          }
        ]
      }
    }
  ],
  edges: [
    {
      id: string,
      source: string,
      target: string,
      type: "skillLink"
    }
  ],
  stats: [
    {
      id: string,
      key: string,
      name: string,
      type: "number" | "boolean"
    }
  ],
  currencies: [
    {
      id: string,
      key: string,
      name: string,
      symbol: string
    }
  ]
}
```

The `source → target` direction is the prerequisite direction: `source` must be unlocked before `target`.

## GitHub Pages

This repository is configured to deploy the Vite production build from `main` using GitHub Actions.

Expected site URL after GitHub Pages is enabled with **GitHub Actions** as the publishing source:

`https://madesai98.github.io/Skill-Tree-Maker/`

The Vite `base` is set to `/Skill-Tree-Maker/` so production assets resolve correctly from the project subpath.

## GitHub Pages

This repository is configured to deploy automatically to GitHub Pages from `main` using `.github/workflows/deploy-pages.yml`.

The Vite base path is `/Skill-Tree-Maker/`, matching the repository Pages URL.
