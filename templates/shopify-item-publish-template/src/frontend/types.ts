export type FieldKey = 'title' | 'description' | 'productType' | 'tags' | 'sku' | 'barcode' | 'price';

export type Mapping = {
  title: 'name';
  description: 'description';
  productType: 'category';
  tags: 'tags';
  sku: 'sku';
  barcode: 'gtin';
  price: 'defaultSalesPrice';
};

export const METAFIELD_PAIRS: { sutton: string; shopify: string }[] = [
  { sutton: 'Top Style', shopify: 'Top Style' },
  { sutton: 'Coverage', shopify: 'coverage' },
  { sutton: 'Sub Class 2', shopify: 'Sub-class 2' },
  { sutton: 'Department', shopify: 'Department' },
  { sutton: 'Collection', shopify: 'Collection' },
  { sutton: 'Style Type', shopify: 'Style Type' },
  { sutton: 'Sub Class', shopify: 'Sub-class' },
  { sutton: 'Year', shopify: 'Year' },
  { sutton: 'Season', shopify: 'Season' },
  { sutton: 'Fabrication', shopify: 'Fabrication' },
  { sutton: 'Color Code', shopify: 'Color Code' },
  { sutton: 'Color', shopify: 'Product Color' },
];

export const DEFAULT_MAPPING: Mapping = {
  title: 'name',
  description: 'description',
  productType: 'category',
  tags: 'tags',
  sku: 'sku',
  barcode: 'gtin',
  price: 'defaultSalesPrice',
};

export type SearchItem = {
  id: string;
  name: string;
  sku: string | null;
  status: string | null;
  itemTypes: string[];
  hasVariants: boolean;
  parent: { id: string; name: string } | null;
};

export type VariantPreview = {
  itemId: string;
  name: string;
  sku: string;
  barcode: string;
  price: number | null;
  priceLabel: string;
  optionsLabel: string;
  issue?: string;
  selected?: boolean;
};

export type PreviewValues = {
  title: string;
  description: string;
  productType: string;
  tags: string[];
  sku: string;
  skuNote: string;
  barcode: string;
  barcodeNote: string;
  price: string;
  priceNote: string;
  variants: VariantPreview[];
  styleColor: string;
  memberOverflow?: boolean;
  metafields: MetafieldPreview[];
};

export type MetafieldPreview = {
  sutton: string;
  shopify: string;
  value: string;
  note?: string;
};

export const UNMAPPED_SHOPIFY_METAFIELDS = [
  'Collection Filter',
  'Bottom Sub Class 2',
  'One Piece Coverage',
  'Image Swatch',
  'MSRP',
  'Fabric and Description',
  'Class',
  'Disclosures',
];

export type CollidingProduct = {
  id: string;
  title: string;
  handle?: string;
  status: string | null;
  skus?: string[];
};

export type StorePlan = {
  id: string;
  label: string;
  shop: string | null;
  domain: string | null;
  configured: boolean;
  ready: boolean;
  action: string;
  actionLabel: string;
  blockers: string[];
  error: string | null;
  product: { id: string; title: string; handle: string; status: string | null } | null;
  collidingProducts: CollidingProduct[];
  createSkus?: string[];
  updateSkus?: string[];
  /** Every SKU already on the matched Shopify product, including sizes that are not selected. */
  productSkus?: string[];
};

export type PreviewData = {
  item: { id: string; name: string };
  values: PreviewValues;
  stores: StorePlan[];
};

export type PublishResult = {
  id: string;
  label: string;
  domain: string | null;
  status: 'created' | 'updated' | 'failed';
  action: string | null;
  actionLabel: string;
  productId: string | null;
  adminUrl: string | null;
  message: string;
};

export type PublishData = {
  results: PublishResult[];
};
