// Deterministically resample the approved public/icons/icon-512.png into the
// Android launcher icon densities. No new mark or color is invented.
import java.awt.AlphaComposite;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.Ellipse2D;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.ImageIO;

public final class GenerateAndroidIcons {
    private static final String[] DENSITIES = {"mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"};
    private static final int[] SCALES = {1, 3, 2, 3, 4};
    private static final int[] BASES = {1, 2, 1, 1, 1};

    private static BufferedImage draw(BufferedImage source, int size, boolean round) {
        int multiplier = round ? 4 : 1;
        int workSize = size * multiplier;
        BufferedImage work = new BufferedImage(workSize, workSize, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = work.createGraphics();
        g.setComposite(AlphaComposite.Src);
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        if (round) g.setClip(new Ellipse2D.Double(0, 0, workSize, workSize));
        g.drawImage(source, 0, 0, workSize, workSize, null);
        g.dispose();
        if (!round) return work;
        BufferedImage result = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D reduced = result.createGraphics();
        reduced.setComposite(AlphaComposite.Src);
        reduced.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        reduced.drawImage(work, 0, 0, size, size, null);
        reduced.dispose();
        return result;
    }

    private static void write(BufferedImage source, Path folder, String name, int size, boolean round) throws Exception {
        Files.createDirectories(folder);
        if (!ImageIO.write(draw(source, size, round), "png", folder.resolve(name).toFile())) {
            throw new IllegalStateException("PNG encoder unavailable");
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: GenerateAndroidIcons <icon-512.png> <res-dir>");
        BufferedImage source = ImageIO.read(new File(args[0]));
        if (source == null || source.getWidth() != 512 || source.getHeight() != 512) {
            throw new IllegalArgumentException("Approved source must be a 512x512 PNG");
        }
        Path res = Path.of(args[1]);
        for (int i = 0; i < DENSITIES.length; i++) {
            int density = SCALES[i] * 100 / BASES[i];
            Path folder = res.resolve("mipmap-" + DENSITIES[i]);
            write(source, folder, "ic_launcher.png", 48 * density / 100, false);
            write(source, folder, "ic_launcher_round.png", 48 * density / 100, true);
            write(source, folder, "ic_launcher_foreground.png", 108 * density / 100, false);
        }
        System.out.printf("Approved PNG background pixel: #%06X%n", source.getRGB(0, 0) & 0xFFFFFF);
    }
}
