import { redirect } from "next/navigation"

// Overview arrives in a later stage. Until then the app opens on a new investigation.
export default function Home() {
  redirect("/new")
}
