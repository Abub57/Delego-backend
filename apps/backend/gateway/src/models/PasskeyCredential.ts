import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * WebAuthn credential storage — Issue #367.
 * Backing table: `passkey_credentials` (migration 040).
 */
export class PasskeyCredential extends Model {
  public id!: string;
  public userId!: string;
  public credentialId!: string;
  public publicKey!: Buffer;
  public counter!: string | number;
  public transports!: string[];
  public name!: string | null;
  public deviceType!: string;
  public backupEligibility!: boolean;
  public backupState!: boolean;
  public aaguid!: string | null;
  public userVerified!: boolean;
  public lastUsedAt!: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

PasskeyCredential.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "users",
        key: "id",
      },
      onDelete: "CASCADE",
    },
    credentialId: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
    },
    publicKey: {
      type: DataTypes.BLOB,
      allowNull: false,
    },
    // BIGINT columns come back from pg as strings to avoid precision loss, so
    // the model type is widened and normalised in the service layer.
    counter: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    transports: {
      type: DataTypes.ARRAY(DataTypes.TEXT),
      allowNull: false,
      defaultValue: [],
    },
    name: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    deviceType: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "single-device",
    },
    backupEligibility: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    backupState: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    aaguid: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    userVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "PasskeyCredential",
    tableName: "passkey_credentials",
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ["credential_id"] },
      { fields: ["user_id"] },
    ],
  }
);
