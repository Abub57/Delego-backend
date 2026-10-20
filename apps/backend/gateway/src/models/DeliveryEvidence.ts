import { Model, DataTypes, type Sequelize, type InitOptions } from "sequelize";
import { sequelize } from "../db.js";

export class DeliveryEvidence extends Model {
  public id!: string;
  public orderId!: string;
  public merchantAddress!: string;
  public sha256Hash!: string;
  public ipfsCid!: string;
  public storageUrl!: string;
  public fileName!: string;
  public mimeType!: string;
  public fileSizeBytes!: number;
  public verifiedAt!: Date;
  public readonly createdAt!: Date;
}

export function initDeliveryEvidence(sequelizeInstance: Sequelize): void {
  DeliveryEvidence.init(
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
        validate: {
          notEmpty: true,
        },
      },
      merchantAddress: {
        type: DataTypes.STRING(56),
        allowNull: false,
        field: "merchant_address",
        validate: {
          isStellarAddress(value: string) {
            if (!/^G[A-Za-z0-9]{55}$/.test(value)) {
              throw new Error("Invalid Stellar address format");
            }
          },
        },
      },
      sha256Hash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: "sha256_hash",
        validate: {
          isSha256(value: string) {
            if (!/^[a-f0-9]{64}$/i.test(value)) {
              throw new Error("Invalid SHA-256 hash format");
            }
          },
        },
      },
      ipfsCid: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: "ipfs_cid",
      },
      storageUrl: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: "storage_url",
      },
      fileName: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: "file_name",
      },
      mimeType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: "mime_type",
      },
      fileSizeBytes: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: "file_size_bytes",
        validate: {
          min: 0,
        },
      },
      verifiedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: "verified_at",
        defaultValue: DataTypes.NOW,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: "created_at",
        defaultValue: DataTypes.NOW,
      },
    },
    {
      sequelize: sequelizeInstance,
      modelName: "DeliveryEvidence",
      tableName: "order_delivery_evidence",
      timestamps: true,
      underscored: true,
      indexes: [
        {
          fields: ["order_id"],
        },
        {
          fields: ["merchant_address"],
        },
        {
          fields: ["ipfs_cid"],
        },
        {
          fields: ["sha256_hash"],
        },
      ],
      constraints: [
        {
          type: "unique",
          fields: ["order_id"],
          name: "unique_evidence_per_order",
        },
      ],
    } as InitOptions<DeliveryEvidence>
  );
}

// Initialize with the default sequelize instance
initDeliveryEvidence(sequelize);