import { Model, DataTypes, type Sequelize } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Issue #520 — Review appeal resolution audit trail.
 *
 * Every administrative verdict on a review appeal is recorded here with the
 * deciding operator, the timestamp, the verdict itself, and the operator's
 * notes, so the moderation history is immutable and queryable.
 */
export type ReviewModerationVerdict =
  | "remove_review"
  | "keep_review"
  | "warn_buyer"
  | "approved"
  | "rejected";

export class ReviewModerationAuditLog extends Model {
  public id!: string;
  public appealId!: string;
  public reviewId!: string;
  public operatorId!: string;
  public verdict!: ReviewModerationVerdict;
  public notes!: string;
  public decidedAt!: Date;
  public readonly createdAt!: Date;
}

export function initReviewModerationAuditLog(sequelizeInstance: Sequelize): void {
  ReviewModerationAuditLog.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      appealId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: "appeal_id",
      },
      reviewId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: "review_id",
      },
      operatorId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: "operator_id",
        comment: "Admin or moderator who rendered the verdict",
      },
      verdict: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: "verdict",
        validate: {
          isIn: [["remove_review", "keep_review", "warn_buyer", "approved", "rejected"]],
        },
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: "",
        field: "notes",
      },
      decidedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: "decided_at",
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
      modelName: "ReviewModerationAuditLog",
      tableName: "review_moderation_audit_logs",
      timestamps: true,
      updatedAt: false,
      underscored: true,
      indexes: [
        { fields: ["appeal_id"] },
        { fields: ["review_id"] },
        { fields: ["operator_id"] },
        { fields: ["decided_at"] },
      ],
    }
  );
}

initReviewModerationAuditLog(sequelize);
