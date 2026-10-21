import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

export class Discount extends Model {
  public id!: string;
  public merchantId!: string;
  public code!: string;
  public discountType!: "percentage" | "fixed_stroops";
  public discountValue!: string;
  public minOrderStroops!: string | null;
  public maxUses!: number | null;
  public usesCount!: number;
  public validFrom!: Date;
  public validUntil!: Date;
  public isActive!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Discount.init(
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
    code: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    discountType: {
      type: DataTypes.STRING(32),
      allowNull: false,
      field: "discount_type",
      validate: {
        isIn: [["percentage", "fixed_stroops"]],
      },
    },
    discountValue: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: "discount_value",
    },
    minOrderStroops: {
      type: DataTypes.STRING(64),
      allowNull: true,
      field: "min_order_stroops",
    },
    maxUses: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "max_uses",
      validate: {
        min: 1,
      },
    },
    usesCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "uses_count",
      validate: {
        min: 0,
      },
    },
    validFrom: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "valid_from",
    },
    validUntil: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "valid_until",
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: "is_active",
    },
  },
  {
    sequelize,
    modelName: "Discount",
    tableName: "discounts",
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ["merchant_id", "code"],
      },
      {
        fields: ["merchant_id"],
      },
      {
        fields: ["code"],
      },
    ],
  },
);
