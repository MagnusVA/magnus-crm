export function compareNullableEfficiency(args: {
  leftRate: number | null;
  rightRate: number | null;
  leftCount: number;
  rightCount: number;
  leftName: string;
  rightName: string;
}) {
  const leftHasRate = args.leftRate !== null;
  const rightHasRate = args.rightRate !== null;
  if (leftHasRate !== rightHasRate) return leftHasRate ? -1 : 1;
  if (args.leftRate !== args.rightRate) {
    return (args.rightRate ?? -1) - (args.leftRate ?? -1);
  }
  if (args.leftCount !== args.rightCount) {
    return args.rightCount - args.leftCount;
  }
  return args.leftName.localeCompare(args.rightName);
}
