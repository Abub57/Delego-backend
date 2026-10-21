import { Model, DataTypes, type Sequelize, type InitOptions } from "sequelize";
import { sequelize } from "../db.js";

export type ReviewStatus = "visible" | "hidden";

export class Review extends Model {
  public id!: string;
  public orderId!: string;
  public productId!: string;
  public buyerAddress!: string;
  public escrowContractId!: string;
  public buyerSignature!: string;
  public rating!: number;
  public title!: string;
  public content!: string;
  public isVisible!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  // Associations
  public readonly product?: import("./Product.js").Product;
}

export function initReview(sequelizeInstance: Sequelize): void {
  Review.init(
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
      productId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: "product_id",
        references: {
          model: "products",
          key: "id",
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
      escrowContractId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: "escrow_contract_id",
      },
      buyerSignature: {
        type: DataTypes.STRING(256),
        allowNull: false,
        field: "buyer_signature",
      },
      rating: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: {
          min: 1,
          max: 5,
        },
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      content: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      isVisible: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: "is_visible",
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
      modelName: "Review",
      tableName: "reviews",
      timestamps: true,
      underscored: true,
      indexes: [
        {
          fields: ["product_id"],
        },
        {
          fields: ["buyer_address"],
        },
        {
          fields: ["created_at"],
        },
        {
          fields: ["is_visible"],
          where: sequelizeInstance.literal("is_visible = true"),
        },
      ],
      constraints: [
        {
          type: "unique",
          fields: ["order_id"],
          name: "unique_review_per_order",
        },
        {
          type: "check",
          fields: ["rating"],
          name: "check_rating_range",
          where: sequelizeInstance.literal("rating >= 1 AND rating <= 5"),
        },
      ],
    } as InitOptions<Review>
  );
}

// Initialize with the default sequelize instance
initReview(sequelize);