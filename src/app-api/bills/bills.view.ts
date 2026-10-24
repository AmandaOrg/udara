export class AirtimeNetworkView {
  billerCode!: string;
  productCode!: string;
  label!: string;
}

export class DataBundleView {
  productCode!: string;
  label!: string;
  /** Naira. */
  amount!: number;
}

export class DataNetworkView {
  billerCode!: string;
  label!: string;
  bundles!: DataBundleView[];
}

export class ElectricityCompanyView {
  billerCode!: string;
  productCode!: string;
  label!: string;
}

export class AirtimeCatalogView {
  networks!: AirtimeNetworkView[];
  minAmount!: number;
  maxAmount!: number;
}

export class DataCatalogView {
  networks!: DataNetworkView[];
}

export class ElectricityCatalogView {
  /** Prepaid meters only. */
  companies!: ElectricityCompanyView[];
  minAmount!: number;
  maxAmount!: number;
}

export class BillCatalogView {
  airtime!: AirtimeCatalogView;
  data!: DataCatalogView;
  electricity!: ElectricityCatalogView;
}
