import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

export class Product extends Model {
  public id!: string;
  public merchantId!: string;
  public sku!: string;
  public title!: string;
  public description!: string | null;
  public priceStroops!: bigint;
  public assetCode!: string;
  public stockQuantity!: number;
  public isListed!: boolean;
  public imageUrl!: string | null;
  public metadata!: Record<string, unknown>;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Product.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    merchantId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "merchant_id",
      references: {
        model: "merchants",
        key: "id",
      },
    },
    sku: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    priceStroops: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "price_stroops",
      validate: {
        isPositive(value: bigint | string) {
          const num = typeof value === "bigint" ? Number(value) : Number(value);
          if (num <= 0) {
            throw new Error("price_stroops must be greater than 0");
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
    stockQuantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "stock_quantity",
      validate: {
        min: 0,
      },
    },
    isListed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: "is_listed",
    },
    imageUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "image_url",
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
  },
  {
    sequelize,
    modelName: "Product",
    tableName: "products",
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ["merchant_id", "sku"],
      },
      {
        fields: ["price_stroops"],
        where: { is_listed: true },
      },
      {
        fields: ["merchant_id", "created_at"],
      },
    ],
  }
);
