import * as React from "react"

const MOBILE_BREAKPOINT = 768
export const SIDEBAR_MOBILE_BREAKPOINT = 1280

function useMediaBelow(breakpoint: number) {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    [breakpoint]
  )

  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < breakpoint,
    () => false
  )
}

export function useIsMobile() {
  return useMediaBelow(MOBILE_BREAKPOINT)
}

/** Sidebar collapses to a sheet below this width (1280px). */
export function useIsSidebarMobile() {
  return useMediaBelow(SIDEBAR_MOBILE_BREAKPOINT)
}
