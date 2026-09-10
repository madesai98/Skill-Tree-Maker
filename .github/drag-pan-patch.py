from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


app = "src/App.tsx"

replace_once(
    app,
    "  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;\n  const isPlaytest = activeView === 'playtest';\n  const [labelLayoutNodes, setLabelLayoutNodes] = useState(nodes);\n\n  useEffect(() => {\n    const timer = window.setTimeout(() => setLabelLayoutNodes(nodes), 90);\n    return () => window.clearTimeout(timer);\n  }, [nodes]);\n",
    "  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;\n  const isPlaytest = activeView === 'playtest';\n  const [labelLayoutNodes, setLabelLayoutNodes] = useState(nodes);\n  const [isNodeDragging, setIsNodeDragging] = useState(false);\n\n  useEffect(() => {\n    // Keep label placement frozen for the entire drag. React Flow updates node\n    // positions on every pointer move; solving here would put graph-wide layout\n    // work back into that hot path. Once dragging ends, the final node state\n    // triggers exactly one debounced layout pass.\n    if (isNodeDragging) return;\n    const timer = window.setTimeout(() => setLabelLayoutNodes(nodes), 90);\n    return () => window.clearTimeout(timer);\n  }, [isNodeDragging, nodes]);\n",
)

replace_once(
    app,
    "  useEffect(() => {\n    const nodeIds = new Set(nodes.map((node) => node.id));\n    setUnlockedNodeIds((current) => {\n      const next = new Set([...current].filter((id) => nodeIds.has(id)));\n      return next.size === current.size ? current : next;\n    });\n  }, [nodes]);\n",
    "  useEffect(() => {\n    if (!isPlaytest) return;\n    const nodeIds = new Set(nodes.map((node) => node.id));\n    setUnlockedNodeIds((current) => {\n      const next = new Set([...current].filter((id) => nodeIds.has(id)));\n      return next.size === current.size ? current : next;\n    });\n  }, [isPlaytest, nodes]);\n",
)

replace_once(
    app,
    "  const showNotice = useCallback((message: string) => {\n    setNotice(message);\n    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);\n    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2200);\n  }, []);\n",
    "  const showNotice = useCallback((message: string) => {\n    setNotice(message);\n    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);\n    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2200);\n  }, []);\n\n  const syncCanvasZoomDetail = useCallback((zoom: number) => {\n    const panel = flowWrapRef.current;\n    if (!panel) return;\n    // This used to be driven by a MutationObserver on the viewport transform,\n    // which meant every pan frame parsed the transform and touched DOM classes.\n    // Updating only when a viewport gesture ends keeps panning transform-only.\n    panel.classList.toggle('is-low-detail-zoom', zoom < 0.2);\n    panel.classList.toggle('is-minimal-detail-zoom', zoom < 0.1);\n  }, []);\n",
)

replace_once(
    app,
    "                onNodesChange={onNodesChange}\n                onEdgesChange={onEdgesChange}\n                onInit={setRfInstance}\n                onNodeClick={(_, node) => isPlaytest ? unlockPlaytestNode(node.id) : setSelectedNodeId(node.id)}\n",
    "                onNodesChange={onNodesChange}\n                onEdgesChange={onEdgesChange}\n                onInit={(instance) => {\n                  setRfInstance(instance);\n                  syncCanvasZoomDetail(instance.getViewport().zoom);\n                }}\n                onMoveEnd={(_, viewport) => syncCanvasZoomDetail(viewport.zoom)}\n                onNodeDragStart={() => setIsNodeDragging(true)}\n                onNodeDragStop={() => setIsNodeDragging(false)}\n                onSelectionDragStart={() => setIsNodeDragging(true)}\n                onSelectionDragStop={() => setIsNodeDragging(false)}\n                onNodeClick={(_, node) => isPlaytest ? unlockPlaytestNode(node.id) : setSelectedNodeId(node.id)}\n",
)

replace_once(
    "src/main.tsx",
    "import './chromeRuntime';\nimport './performanceRuntime';\n",
    "import './chromeRuntime';\n",
)

Path("src/performanceRuntime.ts").unlink(missing_ok=True)
