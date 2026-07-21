import { publicProducts, resetCatalog } from "@/lib/scenario/catalog";
import { ScenarioShell } from "@/components/scenario/scenario-shell";

export const dynamic = "force-dynamic";

/**
 * The demo. This is a Server Component: it strips `cost` server-side (via
 * `publicProducts`) so the browser never receives it. The catalog is reset on
 * each full load so the scenario always starts from the seeded conflicts.
 */
export default function ScenarioPage() {
  resetCatalog();
  return <ScenarioShell initialRows={publicProducts()} />;
}
