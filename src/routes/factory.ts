import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import FactoryPage from "../pages/factory";

export const factoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/factory",
  component: FactoryPage,
});
