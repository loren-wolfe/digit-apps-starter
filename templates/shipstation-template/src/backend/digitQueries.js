const ADDRESS_FIELDS = `
  id title addressLineOne addressLineTwo city state zip country
  isShippingDefault isShipFromDefault isBillingDefault isManufacturingDefault
`;

const ORGANIZATION_FIELDS = `
  id
  name
  replyToEmail
  defaultCurrency { code }
  addresses { ${ADDRESS_FIELDS} }
`;

const MEASUREMENT_FIELDS = `
  value
  uom { name symbol type }
`;

const SHIPMENT_NODE_FIELDS = `
  id
  documentNumber
  shippingNumber
  shippingStatus
  trackingNumber
  notes
  shippingCarrierField { id value }
  createdAt
  shippingAddress { ${ADDRESS_FIELDS} }
  packContainers {
    id
    container
    packageLength { ${MEASUREMENT_FIELDS} }
    packageWidth { ${MEASUREMENT_FIELDS} }
    packageHeight { ${MEASUREMENT_FIELDS} }
    packageGrossWeight { ${MEASUREMENT_FIELDS} }
    packedItems {
      id
      quantity
      pickedItem {
        id
        orderItem {
          id
          quantity
          customerSku
          item { id name sku }
        }
      }
    }
  }
  order {
    id
    documentNumber
    orderNumber
    orderDate
    notes
    customer { id name }
    customerContact { id fullName phone email }
    shippingAddress { ${ADDRESS_FIELDS} }
    billingAddress { ${ADDRESS_FIELDS} }
    shippingCarrierField { id value }
    externalOrder { id connection { id platform storeUniqueName } }
  }
`;

export const SHIPMENT_LIST_QUERY = `
  query ShipStationShipmentQueue($connection: ConnectionInput) {
    organization { ${ORGANIZATION_FIELDS} }
    shipments(
      shippingStatuses: [awaiting_carrier]
      connection: $connection
      order: { by: createdAt, direction: desc }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { ${SHIPMENT_NODE_FIELDS} }
    }
  }
`;

export const SHIPMENT_BY_ID_QUERY = `
  query ShipStationShipmentById($shipmentId: ID!) {
    organization { ${ORGANIZATION_FIELDS} }
    shipment(shipmentId: $shipmentId) { ${SHIPMENT_NODE_FIELDS} }
  }
`;

export const ORDER_DETAIL_QUERY = `
  query ShipStationOrder($orderIds: [ID!], $connection: ConnectionInput) {
    organization { ${ORGANIZATION_FIELDS} }
    orders(
      orderIds: $orderIds
      orderStatuses: [unfulfilled, partially_fulfilled]
      connection: $connection
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        documentNumber
        orderNumber
        orderStatus
        packingStatus
        pickingStatus
        fulfillmentStatus
        notes
        tags { id value }
        customer { id name }
        customerContact { id fullName phone email }
        shippingAddress { ${ADDRESS_FIELDS} }
        billingAddress { ${ADDRESS_FIELDS} }
        packContainers {
          id
          packedItemsTotalCount
          shipment { id }
        }
        shipments {
          id
          shippingStatus
          trackingNumber
          notes
          shippingCarrierField { id value }
        }
        items {
          id
          quantity
          customerSku
          itemAvailability
          totalShippedQuantity
          pickingStatus
          packingStatus
          item { id name sku }
        }
      }
    }
  }
`;

export const ORDER_BY_ID_QUERY = `
  query ShipStationOrderById($orderIds: [ID!]!) {
    organization { ${ORGANIZATION_FIELDS} }
    orders(orderIds: $orderIds, connection: { first: 20 }) {
      nodes {
        id
        documentNumber
        orderNumber
        orderStatus
        packingStatus
        pickingStatus
        fulfillmentStatus
        notes
        tags { id value }
        customer { id name }
        customerContact { id fullName phone email }
        shippingAddress { ${ADDRESS_FIELDS} }
        billingAddress { ${ADDRESS_FIELDS} }
        packContainers {
          id
          packedItemsTotalCount
          shipment { id }
        }
        shipments {
          id
          shippingStatus
          trackingNumber
          notes
          shippingCarrierField { id value }
        }
        items {
          id
          quantity
          customerSku
          itemAvailability
          totalShippedQuantity
          pickingStatus
          packingStatus
          item { id name sku }
        }
      }
    }
  }
`;

export const GENERATE_SALES_ORDER_PDF_QUERY = `
  query ShipStationGenerateSalesOrderPdf($orderId: ID!) {
    generateSalesOrderPdf(orderId: $orderId) { url }
  }
`;

export const ITEMS_BY_SEARCH_QUERY = `
  query ShipStationItems($search: String, $connection: ConnectionInput) {
    items(search: $search, connection: $connection) {
      nodes {
        id
        name
        sku
        defaultSalesPrice { costAmount currency { code } }
      }
    }
  }
`;

export const COMPANIES_SEARCH_QUERY = `
  query ShipStationCompanies($search: String, $connection: ConnectionInput) {
    companies(search: $search, connection: $connection) {
      nodes { id name }
    }
  }
`;

export const CREATE_COMPANY_MUTATION = `
  mutation ShipStationCreateCompany($input: CreateCompanyInput!) {
    createCompany(input: $input) {
      company { id name }
    }
  }
`;

export const CREATE_COMPANY_LOCATION_MUTATION = `
  mutation ShipStationCreateCompanyLocation($input: CreateCompanyLocationInput!) {
    createCompanyLocation(input: $input) {
      address { id }
    }
  }
`;

export const CREATE_ORDER_MUTATION = `
  mutation ShipStationCreateOrder($input: CreateOrderInput!) {
    createOrder(input: $input) {
      order { id documentNumber }
    }
  }
`;

export const CREATE_PACK_CONTAINER_MUTATION = `
  mutation ShipStationCreatePackContainer($input: CreatePackContainerInput!) {
    createPackContainer(input: $input) {
      packContainer { id }
    }
  }
`;

export const SHIPPING_CARRIERS_QUERY = `
  query ShipStationShippingCarriers {
    organizationDynamicFields {
      shippingCarriers {
        options { id value deleted }
      }
    }
  }
`;

export const CREATE_SHIPMENT_MUTATION = `
  mutation ShipStationCreateShipment($input: CreateShipmentInput!) {
    createShipment(input: $input) {
      shipment { id trackingNumber shippingStatus shippingCarrierField { id value } }
    }
  }
`;

export const UPDATE_SHIPMENT_MUTATION = `
  mutation ShipStationUpdateShipment($input: UpdateShipmentInput!) {
    updateShipment(input: $input) {
      shipment { id trackingNumber shippingStatus shippingCarrierField { id value } }
    }
  }
`;

export const UPDATE_ORDER_MUTATION = `
  mutation ShipStationUpdateOrder($input: UpdateOrderInput!) {
    updateOrder(input: $input) {
      order { id }
    }
  }
`;
