import type { Metadata } from "next";

import { loadCatalogSources } from "@/lib/catalog";
import { catalogSourcesPath } from "@/lib/config";
import { getController } from "@/lib/context";

import { CatalogPanel } from "../../catalog-panel";

export const metadata: Metadata = {
  title: "Model prices",
  description: "Review model availability and API-equivalent token prices"
};

export default function PricesPage() {
  const { store } = getController();
  const catalog = loadCatalogSources(catalogSourcesPath());

  return (
    <div className="routePage">
      <header className="routeHero compactHero">
        <div>
          <p className="eyebrow"><span /> Cost catalog</p>
          <h1>Rates you can<br /><em>stand behind.</em></h1>
          <p className="lede">
            Review discovered models, approve official API rates, and keep fleet
            cost estimates grounded in a source.
          </p>
        </div>
      </header>
      <CatalogPanel
        checks={store.catalogChecks(8)}
        models={store.catalogModels()}
        prices={store.modelPrices()}
        sources={
          catalog.sources === null
            ? null
            : {
                schedule: catalog.sources.schedule,
                auto_apply: catalog.sources.autoApply,
                providers: catalog.sources.providers.map((provider) => ({
                  key: provider.key,
                  provider: provider.provider,
                  model_api_enabled: provider.modelApi?.enabled ?? false,
                  model_documents: provider.modelDocuments,
                  pricing_documents: provider.pricingDocuments
                }))
              }
        }
        sourcesError={catalog.error}
      />
    </div>
  );
}
