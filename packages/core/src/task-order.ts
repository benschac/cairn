import type { TaskId } from "@cairn/contract";
import { Order, String } from "effect";

/** Orders task ids by their number, so `t2` comes before `t10`. */
export const TaskIdOrder: Order.Order<TaskId> = Order.make((self, that) =>
  String.localeCompare(that, ["en"], { numeric: true })(self),
);
