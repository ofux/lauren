import { Text } from 'ink';
import type React from 'react';

import { spinnerFrame } from '../core/time.js';

interface Props {
  color?: string;
  bold?: boolean;
}

export function Spinner({ color = 'cyan', bold = true }: Props): React.ReactElement {
  const props: { bold?: boolean; color?: string } = {};
  if (bold) props.bold = true;
  if (color) props.color = color;
  return <Text {...props}>{spinnerFrame()}</Text>;
}
