import { Model, DataTypes, type Sequelize, type InitOptions } from "sequelize";
import { sequelize } from "../db.js";

export type AppealReasonCategory = "spam" | "abusive" | "unrelated" | "fraudulent";
export type AppealStatus = "pending_review" | "approved" | "rejected";

export class ReviewAppeal extends Model {
  public id!: string;
  public reviewId!: string;
  public merchantId!: string;
  public reasonCategory!: AppealReasonCategory;
  public justification!: string;
  public evidenceUrls!: string[];
  public status!: AppealStatus;
  public moderatorNotes!: string | null;
  public moderatorId!: string | null;
  public resolvedAt!: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  // Associations
  public readonly review?: import("./Review.js").Review;
  public readonly merchant?: import("./Merchant.js").Merchant;
}

export function initReviewAppeal(sequelizeInstance: Sequelize): void {
  ReviewAppeal.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      reviewId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: "review_id",
        references: {
          model: "reviews",
          key: "id",
        },
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
      reasonCategory: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: "reason_category",
        validate: {
          isIn: [["spam", "abusive", "unrelated", "fraudulent"]],
        },
      },
      justification: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      evidenceUrls: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: false,
        defaultValue: [],
        field: "evidence_urls",
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: "pending_review",
        field: "status",
        validate: {
          isIn: [["pending_review", "approved", "rejected"]],
        },
      },
      moderatorNotes: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: "moderator_notes",
      },
      moderatorId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: "moderator_id",
      },
      resolvedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: "resolved_at",
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
      modelName: "ReviewAppeal",
      tableName: "review_appeals",
      timestamps: true,
      underscored: true,
      indexes: [
        {
          fields: ["review_id"],
        },
        {
          fields: ["merchant_id"],
        },
        {
          fields: ["status"],
        },
      ],
      constraints: [
        {
          type: "unique",
          fields: ["review_id"],
          name: "unique_appeal_per_review",
        },
      ],
    } as InitOptions<ReviewAppeal>
  );
}

// Initialize with the default sequelize instance
initReviewAppeal(sequelize);