export type BudgetBlock = "needs" | "leisure" | "savings" | "unclassified";
export type BudgetCategory =
  | "income"
  | "housing"
  | "utilities"
  | "groceries"
  | "transport"
  | "health"
  | "subscriptions"
  | "food_out"
  | "shopping"
  | "travel"
  | "savings_transfer"
  | "other"
  | "unclassified";

export interface BudgetRule {
  id: string;
  contains: string;
  label: string;
  block: Exclude<BudgetBlock, "unclassified">;
  category: Exclude<BudgetCategory, "income" | "unclassified">;
  planned: boolean;
}

export interface BudgetManualMovement {
  id: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  bank: string;
  block: BudgetBlock;
  category: BudgetCategory;
  planned: boolean;
  status: "pending" | "confirmed";
  created_at: string;
}

export interface BudgetOverride {
  block?: BudgetBlock;
  category?: BudgetCategory;
  planned?: boolean;
}

export interface BudgetState {
  payroll_day: number;
  monthly_income: number;
  budgets: {
    needs: number;
    leisure: number;
    savings: number;
  };
  rules: BudgetRule[];
  manual_movements: BudgetManualMovement[];
  overrides: Record<string, BudgetOverride>;
}

export const defaultBudgetState = (): BudgetState => ({
  payroll_day: 28,
  monthly_income: 2_800,
  budgets: { needs: 1_650, leisure: 320, savings: 500 },
  rules: [
    { id: "rule-housing", contains: "alquiler,rent,hipoteca,mortgage", label: "Vivienda", block: "needs", category: "housing", planned: true },
    { id: "rule-grocery", contains: "mercadona,carrefour,lidl,aldi,eroski,supermercado,grocery", label: "Compra", block: "needs", category: "groceries", planned: true },
    { id: "rule-utility", contains: "iberdrola,endesa,agua,internet,telefonica,orange,vodafone", label: "Suministros", block: "needs", category: "utilities", planned: true },
    { id: "rule-transport", contains: "uber,cabify,metro,renfe,gasolin,combustible", label: "Transporte", block: "needs", category: "transport", planned: true },
    { id: "rule-subscriptions", contains: "netflix,spotify,apple.com,icloud,prime video,disney", label: "Suscripciones", block: "leisure", category: "subscriptions", planned: true },
    { id: "rule-food-out", contains: "restaurante,restaurant,deliveroo,ubereats,glovo,bar,cafe", label: "Comer fuera", block: "leisure", category: "food_out", planned: true },
    { id: "rule-shopping", contains: "amazon,zara,el corte ingles,decathlon", label: "Compras", block: "leisure", category: "shopping", planned: false },
    { id: "rule-savings", contains: "ahorro,savings", label: "Ahorro", block: "savings", category: "savings_transfer", planned: true },
  ],
  manual_movements: [],
  overrides: {},
});
