import { FileSearch, LayoutGrid, ListChecks, FolderOpen, type LucideIcon } from "lucide-react"

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
  /** Not built yet: shown, but not a link. */
  soon?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { title: "Overview", href: "/overview", icon: LayoutGrid, soon: true },
  { title: "New Investigation", href: "/new", icon: FileSearch },
  { title: "Results", href: "/results", icon: ListChecks },
  { title: "Reports", href: "/reports", icon: FolderOpen, soon: true },
]
