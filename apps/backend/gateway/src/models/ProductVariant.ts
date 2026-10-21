import { Model, DataTypes, type Sequelize } from "sequelize";
import { sequelize } from "../db.js";

/**
 * ProductVariant - Represents variable products with attributes like size, color, material
 * Supports SKU inventory counts, prices, and barcodes
 */
export class ProductVariant extends Model {
  public id!: string;
  public productId!: string;
  public sku!: string;
  public attributes!: Record<string, unknown>;
  public priceStroops!: bigint;
  public stockCount!: number;
  public barcode!: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  // Associations
  public readonly product?: import("./Product.js").Product;
}

export function initProductVariant(sequelizeInstance: Sequelize): void {
  ProductVariant.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      productId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: "product_id",
        references: {
          model: "products",
          key: "id",
        },
      },
      sku: {
        type: DataTypes.STRING(64),
        allowNull: false,
        validate: {
          notEmpty: true,
        },
      },
      attributes: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        validate: {
          isObject(value: unknown) {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              throw new Error("attributes must be a JSON object");
            }
          },
        },
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
      stockCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: "stock_count",
        validate: {
          min: 0,
        },
      },
      barcode: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: "barcode",
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
      modelName: "ProductVariant",
      tableName: "product_variants",
      timestamps: true,
      underscored: true,
      indexes: [
        {
          fields: ["product_id"],
        },
        {
          fields: ["attributes"],
          using: "gin",
        },
        {
          fields: ["stock_count"],
          where: sequelizeInstance.literal("stock_count > 0"),
        },
        {
          fields: ["barcode"],
          where: sequelizeInstance.literal("barcode IS NOT NULL"),
        },
      ],
    }
  );
}

// Initialize with the default sequelize instance
initProductVariant(sequelize);