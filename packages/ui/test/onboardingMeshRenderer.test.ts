import { describe, expect, it, vi } from "vitest";
import { createOnboardingMeshRenderer } from "@/onboarding/onboardingMeshRenderer.js";

describe("引导背景 GPU 降级", () => {
  it("限制绘制分辨率，并在退出时释放 GPU 对象", () => {
    const gl = {
      createShader: () => ({}),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: () => true,
      deleteShader: vi.fn(),
      createProgram: () => ({}),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: () => true,
      createBuffer: () => ({}),
      useProgram: vi.fn(),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      getAttribLocation: () => 0,
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      getUniformLocation: () => ({}),
      viewport: vi.fn(),
      uniform1f: vi.fn(),
      uniform3f: vi.fn(),
      drawArrays: vi.fn(),
      deleteBuffer: vi.fn(),
      deleteProgram: vi.fn(),
    };
    const canvas = { getContext: () => gl, width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const renderer = createOnboardingMeshRenderer(canvas)!;
    renderer.draw(1, 1800, 1200, [0.5, 0.75, 1]);
    expect(gl.uniform3f).toHaveBeenCalledWith(expect.anything(), 0.5, 0.75, 1);
    expect([canvas.width, canvas.height]).toEqual([960, 640]);
    expect(gl.drawArrays).toHaveBeenCalledOnce();
    renderer.dispose();
    expect(gl.deleteBuffer).toHaveBeenCalledOnce();
    expect(gl.deleteProgram).toHaveBeenCalledOnce();
  });
  it("WebGL 不可用时返回静态降级，不影响引导", () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(createOnboardingMeshRenderer(canvas)).toBeNull();
  });
  it("编译失败释放已经创建的 shader", () => {
    const shader = {};
    const gl = {
      VERTEX_SHADER: 1,
      COMPILE_STATUS: 2,
      createShader: () => shader,
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: () => false,
      deleteShader: vi.fn(),
    };
    const canvas = { getContext: () => gl } as unknown as HTMLCanvasElement;
    expect(createOnboardingMeshRenderer(canvas)).toBeNull();
    expect(gl.deleteShader).toHaveBeenCalledWith(shader);
  });
});
