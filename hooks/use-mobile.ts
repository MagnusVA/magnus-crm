import * as React from "react"

const MOBILE_BREAKPOINT = 768
export const SIDEBAR_MOBILE_BREAKPOINT = 1280

function useMediaBelow(breakpoint: number) {
  const [isBelow, setIsBelow] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const onChange = () => {
      setIsBelow(window.innerWidth < breakpoint)
    }
    mql.addEventListener("change", onChange)
    setIsBelow(window.innerWidth < breakpoint)
    return () => mql.removeEventListener("change", onChange)
  }, [breakpoint])

  return !!isBelow
}

export function useIsMobile() {
  return useMediaBelow(MOBILE_BREAKPOINT)
}

/** Sidebar collapses to a sheet below this width (1280px). */
export function useIsSidebarMobile() {
  return useMediaBelow(SIDEBAR_MOBILE_BREAKPOINT)
}
