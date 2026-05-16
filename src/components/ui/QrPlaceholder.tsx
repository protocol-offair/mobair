import { StyleSheet, View } from "react-native";

import { palette, radii } from "../../theme/palette";

function shouldFill(seed: string, row: number, col: number) {
  const charCode = seed.charCodeAt((row * 7 + col * 11) % seed.length) || 0;
  return (charCode + row * 13 + col * 17) % 3 === 0;
}

function isFinder(row: number, col: number, size: number) {
  const inTopLeft = row < 5 && col < 5;
  const inTopRight = row < 5 && col >= size - 5;
  const inBottomLeft = row >= size - 5 && col < 5;
  return inTopLeft || inTopRight || inBottomLeft;
}

function isFinderCenter(row: number, col: number, size: number) {
  const inTopLeft = row >= 1 && row <= 3 && col >= 1 && col <= 3;
  const inTopRight = row >= 1 && row <= 3 && col >= size - 4 && col <= size - 2;
  const inBottomLeft = row >= size - 4 && row <= size - 2 && col >= 1 && col <= 3;
  return inTopLeft || inTopRight || inBottomLeft;
}

export function QrPlaceholder(props: { value: string }) {
  const seed = props.value || "AIRPAY";
  const size = 17;

  return (
    <View style={styles.wrapper}>
      {Array.from({ length: size }).map((_, row) => (
        <View key={`row-${row}`} style={styles.row}>
          {Array.from({ length: size }).map((__, col) => {
            const filled = isFinder(row, col, size) || shouldFill(seed, row, col);
            const color = isFinderCenter(row, col, size) ? palette.background : filled ? palette.background : "#FFFFFF";

            return <View key={`${row}-${col}`} style={[styles.cell, { backgroundColor: color }]} />;
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: 224,
    height: 224,
    borderRadius: radii.lg,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
    padding: 16,
    gap: 2,
  },
  row: {
    flexDirection: "row",
    gap: 2,
    flex: 1,
  },
  cell: {
    flex: 1,
    borderRadius: 1,
  },
});
