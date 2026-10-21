import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

export class Merchant extends Model {
  public id!: string;
  public ownerUserId!: string;
  public storeName!: string;
  public description!: string | null;
  public stellarAddress!: string;
  public contactEmail!: string;
  public category!: string;
  public isVerified!: boolean;
  public reputationScore!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Merchant.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    ownerUserId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "owner_user_id",
      references: {
        model: "users",
        key: "id",
      },
    },
    storeName: {
      type: DataTypes.STRING(128),
      allowNull: false,
      field: "store_name",
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    stellarAddress: {
      type: DataTypes.STRING(56),
      allowNull: false,
      unique: true,
      field: "stellar_address",
      validate: {
        isStellarFormat(value: string) {
          if (value.length !== 56 || !value.startsWith("G")) {
            throw new Error("Invalid Stellar address format");
          }
        },
      },
    },
    contactEmail: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: "contact_email",
      validate: {
        isEmail: true,
      },
    },
    category: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "is_verified",
    },
    reputationScore: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
      field: "reputation_score",
      validate: {
        min: 0,
        max: 100,
      },
    },
  },
  {
    sequelize,
    modelName: "Merchant",
    tableName: "merchants",
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ["stellar_address"],
      },
      {
        fields: ["owner_user_id"],
      },
      {
        fields: ["category", "is_verified"],
        where: { is_verified: true },
      },
    ],
  }
);
