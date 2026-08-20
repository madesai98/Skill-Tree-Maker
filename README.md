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
- Multi-project browser persistence, with independent undo/redo history for every local project.
- Optional Firestore-backed online projects with realtime updates between trusted collaborators.
- Per-browser UUID identity for collaborative history. Firebase Authentication is not required by the application.
- Conflict-safe collaborative undo/redo: an older action cannot overwrite a field or structural entity that another collaborator changed afterward.
- Explicit project copy operations between Local and Online modes instead of implicit synchronization.
- JSON project import/export.
- Version-1 project migration: old numeric costs are automatically assigned to the default currency.
- Existing single-project local data is migrated into the multi-project local store on first launch.
- Imported edges are sanitized so cyclic, duplicate, self-referential, or dangling links are not loaded.
- Responsive desktop and mobile layouts.

## Projects and storage modes

The application starts in **Local** mode. The Projects control in the top bar lets you create, rename, duplicate, switch, and delete skill-tree projects. Every local project has independent project data and history.

Local and Online projects are intentionally separate. Use **Copy Online** or **Copy Local** to create a copy in the other storage mode. Switching storage modes never silently uploads, downloads, merges, or overwrites projects.

The first time the multi-project version opens, the existing `incremental-td-skill-tree:v2` project is preserved as a local project named `My Skill Tree`. Existing v2 atomic history is migrated to that project's history when available.

## Online mode / Firestore

Online mode uses the Firebase web SDK and Cloud Firestore. In the Projects control:

1. Select **Online**.
2. Paste the Firebase web configuration for a Firestore-enabled Firebase project.
3. Choose **Connect Firebase**.
4. Create a cloud project or copy an existing local project online.
5. Give trusted collaborators the same Firebase configuration. They will see the same cloud project collection.

The configuration is stored only in that browser's local storage by Skill Tree Maker; it is not compiled into the repository. This mode intentionally does not add Firebase Authentication. The application generates a UUID on first launch and stores it in local storage. That UUID is used to separate each collaborator's history, not as a security credential.

Configure Firestore Security Rules to match the trust/access model for the Firebase project. The app does not install or modify Firestore rules for you.

Cloud data is stored under the top-level `skillTreeMakerProjects` collection. Each project document contains the current canonical tree plus mutation/revision metadata. Per-user history is stored under:

```text
skillTreeMakerProjects/<projectId>/histories/<localUserUuid>
```

Collaborative writes use Firestore transactions. Each atomic field has last-writer metadata, and structurally sensitive entities also have mutation ownership metadata. Undo/redo checks that metadata before committing. For example, if one user creates a skill and another user later edits or connects that skill, the creator's older "add skill" action can no longer be undone in a way that deletes the collaborator's newer work.

Remote Firestore snapshots update the editor state but do not create history entries for the receiving user. A user's History panel therefore contains only that user's own cloud actions for the selected project.

Online edits require an active Firestore connection. The initial collaborative implementation does not queue offline cloud mutations for later rebasing; switch to Local mode when fully offline editing is required.

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

This repository is configured to deploy automatically to GitHub Pages from `main` using `.github/workflows/deploy-pages.yml`.

The expected production URL is:

`https://madesai98.github.io/Skill-Tree-Maker/`

The Vite base path is `/Skill-Tree-Maker/`, matching the repository Pages URL.
