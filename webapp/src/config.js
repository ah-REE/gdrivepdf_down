// Runtime mode. 'static' = the hosted build that needs no backend:
// direct downloads happen via native browser downloads and view-only
// captures run through the bookmarklet. 'backend' = the full local app.
export const MODE = import.meta.env.VITE_MODE === 'static' ? 'static' : 'backend'
