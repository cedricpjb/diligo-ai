"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { isSampleMode } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { BrandMark } from "./brand-mark"
import { NAV_ITEMS } from "./nav"

export function AppSidebar() {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 pt-4 pb-3 group-data-[collapsible=icon]:px-2">
        <Link
          href="/new"
          className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => isMobile && setOpenMobile(false)}
        >
          <BrandMark />
          <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-tight">
              Diligo<span className="text-muted-foreground">.ai</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">
              Every claim. Verified by evidence.
            </span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {NAV_ITEMS.map((item) => {
                const active = pathname.startsWith(item.href)
                const Icon = item.icon

                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={item.title}
                      className={cn(
                        "relative h-11 text-muted-foreground md:h-10 transition-colors duration-150 hover:text-foreground",
                        "data-active:bg-sidebar-accent data-active:text-foreground",
                        "before:absolute before:top-2 before:bottom-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand before:opacity-0 before:transition-opacity data-active:before:opacity-100",
                        "data-active:[&>svg]:text-brand"
                      )}
                      render={
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          onClick={() => isMobile && setOpenMobile(false)}
                        />
                      }
                    >
                      <Icon aria-hidden />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-3 group-data-[collapsible=icon]:hidden">
        <div className="rounded-lg border border-border px-3 py-2.5 text-xs leading-relaxed">
          <p className="font-semibold text-foreground">
            {isSampleMode ? "Sample data" : "Live API"}
          </p>
          <p className="text-muted-foreground">
            {isSampleMode
              ? "No API URL is set, so results come from the starter case."
              : "Files are checked by the Diligo.ai server."}
          </p>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
