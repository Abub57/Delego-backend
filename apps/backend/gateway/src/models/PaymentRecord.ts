import { Model, DataTypes, type Sequelize } from "sequelize";
import { sequelize } from "../db.js";

export type PaymentRecordStatus = 
  | "pending" 
  | "funded" 
  | "released" 
  | "settled" 
  | "cancelled" 
  | "refunded";

export class PaymentRecord extends Model {
  public id!: string;
  public orderId!: string;
  public buyerAddress!: string;
  public sellerAddress!: string;
  public escrowContractId!: string;
  public amountStroops!: bigint;
  public assetCode!: string;
  public status!: PaymentRecordStatus;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

export function initPaymentRecord(sequelizeInstance: Sequelize): void {
  PaymentRecord.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      orderId: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: "order_id",
        unique: true,
        validate: {
          notEmpty: true,
        },
      },
      buyerAddress: {
        type: DataTypes.STRING(56),
        allowNull: false,
        field: "buyer_address",
        validate: {
          isStellarAddress(value: string) {
            if (!/^G[A-Za-z0-9]{55}$/.test(value)) {
              throw new Error("Invalid Stellar address format");
            }
          },
        },
      },
      sellerAddress: {
        type: DataTypes.STRING(56),
        allowNull: false,
        field: "seller_address",
        validate: {
          isStellarAddress(value: string) {
            if (!/^G[A-Za-z0-9]{55}$/.test(value)) {
              throw new Error("Invalid Stellar address format");
            }
          },
        },
      },
      escrowContractId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: "escrow_contract_id",
      },
      amountStroops: {
        type: DataTypes.BIGINT,
        allowNull: false,
        field: "amount_stroops",
        validate: {
          isPositive(value: bigint | string) {
            const num = typeof value === "bigint" ? Number(value) : Number(value);
            if (num < 0) {
              throw new Error("amount_stroops must be non-negative");
            }
          },
        },
      },
      assetCode: {
        type: DataTypes.STRING(12),
        allowNull: false,
        defaultValue: "USDC",
        field: "asset_code",
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: "pending",
        field: "status",
        validate: {
          isIn: [["pending", "funded", "released", "settled", "cancelled", "refunded"]],
        },
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: "created_at",
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: "updated_at",
        defaultValue: DataTypes.NOW,
      },
    },
    {
      sequelize: sequelizeInstance,
      modelName: "PaymentRecord",
      tableName: "payment_records",
      timestamps: true,
      underscored: true,
      indexes: [
        {
          fields: ["order_id"],
        },
        {
          fields: ["buyer_address"],
        },
        {
          fields: ["status"],
        },
        {
          fields: ["escrow_contract_id"],
        },
      ],
    }
  );
}

// Initialize with the default sequelize instance
initPaymentRecord(sequelize);