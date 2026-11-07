"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { SidebarTrigger } from "@/components/ui/sidebar"
import { BrandMark } from "./brand-mark"
import { NAV_ITEMS } from "./nav"

export function AppHeader() {
  const pathname = usePathname()
  const current = NAV_ITEMS.find((item) => pathname.startsWith(item.href))

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur-md sm:px-5">
      <SidebarTrigger
        aria-label="Toggle navigation"
        className="size-10 text-muted-foreground hover:text-foreground md:size-8"
      />
      <span aria-hidden className="mx-1 hidden h-4 w-px bg-border md:block" />
      <Link
        href="/new"
        className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
      >
        <BrandMark className="size-7" />
        <span className="text-sm font-semibold tracking-tight">
          Diligo<span className="text-muted-foreground">.ai</span>
        </span>
      </Link>
      {current && (
        <p className="hidden text-sm text-muted-foreground md:block">{current.title}</p>
      )}
    </header>
  )
}
