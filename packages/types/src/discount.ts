export interface CreateDiscountDTO {
  code: string;
  discountType: "percentage" | "fixed_stroops";
  discountValue: string;
  minOrderStroops?: string;
  maxUses?: number;
  validFrom: string;
  validUntil: string;
}

export interface DiscountResponse {
  id: string;
  merchantId: string;
  code: string;
  discountType: "percentage" | "fixed_stroops";
  discountValue: string;
  minOrderStroops?: string;
  maxUses?: number;
  usesCount: number;
  validFrom: string;
  validUntil: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
