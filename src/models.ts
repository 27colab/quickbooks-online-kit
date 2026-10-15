/** Minimal, honest QBO entity shapes: only the fields this kit reads or writes. */
export interface Ref {
  value: string;
  name?: string;
}

export interface QboEntity {
  Id: string;
  SyncToken: string;
  [key: string]: unknown;
}

export interface Customer extends QboEntity {
  DisplayName: string;
  Active?: boolean;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  GivenName?: string;
  FamilyName?: string;
  CompanyName?: string;
  BillAddr?: Address;
}

export interface Address {
  Line1?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
}

export interface Item extends QboEntity {
  Name: string;
  Type: string;
  UnitPrice?: number;
  Active?: boolean;
  IncomeAccountRef?: Ref;
}

export interface SalesLine {
  DetailType: 'SalesItemLineDetail';
  Amount: number;
  Description?: string;
  SalesItemLineDetail: {
    ItemRef: Ref;
    Qty?: number;
    UnitPrice?: number;
    TaxCodeRef?: Ref;
  };
}

export interface LinkedTxn {
  TxnId: string;
  TxnType: string;
}

export interface Transaction extends QboEntity {
  CustomerRef: Ref;
  TotalAmt: number;
  TxnDate?: string;
  DocNumber?: string;
  TxnStatus?: string;
  Line: Array<SalesLine | { DetailType: string; [k: string]: unknown }>;
  LinkedTxn?: LinkedTxn[];
}

export type Estimate = Transaction;
export type Invoice = Transaction;
export type SalesReceipt = Transaction;

export interface Payment extends QboEntity {
  CustomerRef: Ref;
  TotalAmt: number;
}

export interface CompanyInfo extends QboEntity {
  CompanyName: string;
  Country?: string;
}

// ---- inputs -------------------------------------------------------------

export interface CustomerInput {
  displayName?: string;
  givenName?: string;
  familyName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  address?: { line1?: string; city?: string; state?: string; postalCode?: string };
}

export interface LineInput {
  itemId: string;
  description?: string;
  qty?: number;
  /** Defaults to the item's price when omitted and a `unitPrice` is not given. */
  unitPrice?: number;
  /** Computed as qty * unitPrice when omitted. */
  amount?: number;
  taxCodeId?: string;
}

export interface DocumentInput {
  customerId: string;
  lines: LineInput[];
  txnDate?: string;
  docNumber?: string;
  privateNote?: string;
  customerMemo?: string;
  billEmail?: string;
}

export interface PaymentInput {
  customerId: string;
  invoiceId: string;
  amount: number;
  txnDate?: string;
  paymentMethodId?: string;
  depositToAccountId?: string;
  /** Free text reference, e.g. a processor charge id. */
  referenceNumber?: string;
}

export interface PriceMapEntry {
  id: string;
  name: string;
  unitPrice: number | undefined;
  type: string;
}
export type PriceMap = Record<string, PriceMapEntry>;
