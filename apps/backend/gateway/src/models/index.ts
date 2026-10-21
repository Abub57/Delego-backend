import type { HasManyOptions } from "sequelize";
import { User } from "./User.js";
import { Wallet } from "./Wallet.js";
import { Delegation } from "./Delegation.js";
import { SpendLimit } from "./SpendLimit.js";
import { DelegationPolicy } from "./DelegationPolicy.js";
import { PermissionLevel } from "./PermissionLevel.js";
import { RefreshToken } from "./RefreshToken.js";
import { OAuthAccount } from "./OAuthAccount.js";
import { PasskeyCredential } from "./PasskeyCredential.js";
import { PasskeyChallenge } from "./PasskeyChallenge.js";
import { Product } from "./Product.js";
import { ProductVariant } from "./ProductVariant.js";
import { Review } from "./Review.js";
import { ReviewAppeal } from "./ReviewAppeal.js";
import { ReviewModerationAuditLog } from "./ReviewModerationAuditLog.js";
export type { ReviewModerationVerdict } from "./ReviewModerationAuditLog.js";
import { DeliveryEvidence } from "./DeliveryEvidence.js";
import { PaymentRecord } from "./PaymentRecord.js";
import { Merchant } from "./Merchant.js";
import { Discount } from "./Discount.js";

// User <-> Wallet (One-to-Many)
User.hasMany(Wallet, { foreignKey: "userId", as: "wallets" });
Wallet.belongsTo(User, { foreignKey: "userId", as: "user" });

// User <-> Delegation (One-to-Many)
User.hasMany(Delegation, { foreignKey: "userId", as: "delegations" });
Delegation.belongsTo(User, { foreignKey: "userId", as: "user" });

// User <-> SpendLimit (One-to-Many)
User.hasMany(SpendLimit, { foreignKey: "userId", as: "spendLimits" });
SpendLimit.belongsTo(User, { foreignKey: "userId", as: "user" });

// User <-> RefreshToken (One-to-Many)
User.hasMany(RefreshToken, { foreignKey: "userId", as: "refreshTokens" });
RefreshToken.belongsTo(User, { foreignKey: "userId", as: "user" });

// User <-> OAuthAccount (One-to-Many)
User.hasMany(OAuthAccount, { foreignKey: "userId", as: "oauthAccounts" });
OAuthAccount.belongsTo(User, { foreignKey: "userId", as: "user" });

// User <-> PasskeyCredential (One-to-Many) — Issue #367
User.hasMany(PasskeyCredential, { foreignKey: "userId", as: "passkeys" });
PasskeyCredential.belongsTo(User, { foreignKey: "userId", as: "user" });

// Wallet <-> SpendLimit (One-to-Many)
Wallet.hasMany(SpendLimit, { foreignKey: "walletId", as: "spendLimits" });
SpendLimit.belongsTo(Wallet, { foreignKey: "walletId", as: "wallet" });

// Delegation <-> SpendLimit (One-to-Many)
Delegation.hasMany(SpendLimit, { foreignKey: "delegationId", as: "spendLimits" });
SpendLimit.belongsTo(Delegation, { foreignKey: "delegationId", as: "delegation" });

// Delegation <-> DelegationPolicy (One-to-One)
Delegation.hasOne(DelegationPolicy, { foreignKey: "delegationId", as: "delegationPolicy" });
DelegationPolicy.belongsTo(Delegation, { foreignKey: "delegationId", as: "delegation" });

// Delegation <-> PermissionLevel (One-to-One)
Delegation.hasOne(PermissionLevel, { foreignKey: "delegationId", as: "permissionLevel" });
PermissionLevel.belongsTo(Delegation, { foreignKey: "delegationId", as: "delegation" });

// User <-> Merchant (One-to-Many)
User.hasMany(Merchant, { foreignKey: "ownerUserId", as: "merchants" });
Merchant.belongsTo(User, { foreignKey: "ownerUserId", as: "owner" });

// Merchant <-> Product (One-to-Many)
Merchant.hasMany(Product, { foreignKey: "merchantId", as: "products" });
Product.belongsTo(Merchant, { foreignKey: "merchantId", as: "merchant" });

// Product <-> ProductVariant (One-to-Many)
Product.hasMany(ProductVariant, { foreignKey: "productId", as: "variants" });
ProductVariant.belongsTo(Product, { foreignKey: "productId", as: "product" });

// Product <-> Review (One-to-Many)
Product.hasMany(Review, { foreignKey: "productId", as: "reviews" });
Review.belongsTo(Product, { foreignKey: "productId", as: "product" });

// Review <-> ReviewAppeal (One-to-One)
Review.hasOne(ReviewAppeal, { foreignKey: "reviewId", as: "appeal" });
ReviewAppeal.belongsTo(Review, { foreignKey: "reviewId", as: "review" });

// Merchant <-> ReviewAppeal (One-to-Many)
Merchant.hasMany(ReviewAppeal, { foreignKey: "merchantId", as: "appeals" });
ReviewAppeal.belongsTo(Merchant, { foreignKey: "merchantId", as: "merchant" });

// ReviewAppeal <-> ReviewModerationAuditLog (One-to-Many) — Issue #520
ReviewAppeal.hasMany(ReviewModerationAuditLog, { foreignKey: "appealId", as: "auditLogs" });
ReviewModerationAuditLog.belongsTo(ReviewAppeal, { foreignKey: "appealId", as: "appeal" });

// PaymentRecord associations (for review buyer verification)
PaymentRecord.hasMany(Review, { foreignKey: "orderId", targetKey: "orderId", as: "reviews" } as HasManyOptions);
Review.belongsTo(PaymentRecord, { foreignKey: "orderId", targetKey: "orderId", as: "payment" });

// Merchant <-> Discount (One-to-Many)
Merchant.hasMany(Discount, { foreignKey: "merchantId", as: "discounts" });
Discount.belongsTo(Merchant, { foreignKey: "merchantId", as: "merchant" });

export {
  User,
  Wallet,
  Delegation,
  SpendLimit,
  DelegationPolicy,
  PermissionLevel,
  RefreshToken,
  OAuthAccount,
  PasskeyCredential,
  PasskeyChallenge,
  Product,
  ProductVariant,
  Review,
  ReviewAppeal,
  ReviewModerationAuditLog,
  DeliveryEvidence,
  PaymentRecord,
  Merchant,
  Discount,
};
