import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * WebAuthn ceremony challenge storage — Issue #367.
 * Backing table: `passkey_challenges` (migration 040).
 *
 * Challenges are persisted rather than kept in a signed cookie so they are
 * strictly single-use and can be expired and revoked centrally.
 */
export class PasskeyChallenge extends Model {
  public id!: string;
  public challenge!: string;
  public type!: "registration" | "authentication";
  public userId!: string | null;
  public expiresAt!: Date;
  public readonly createdAt!: Date;
}

PasskeyChallenge.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    challenge: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
    },
    type: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: "users",
        key: "id",
      },
      onDelete: "CASCADE",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: "PasskeyChallenge",
    tableName: "passkey_challenges",
    timestamps: true,
    underscored: true,
    indexes: [{ unique: true, fields: ["challenge"] }, { fields: ["expires_at"] }],
  }
);
