// Re-mounts on every navigation, so each screen gets one short entrance.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-in flex flex-1 flex-col">{children}</div>
}
