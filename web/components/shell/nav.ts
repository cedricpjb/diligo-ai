import { FileSearch, ListChecks, type LucideIcon } from "lucide-react"

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { title: "New Investigation", href: "/new", icon: FileSearch },
  { title: "Results", href: "/results", icon: ListChecks },
]
